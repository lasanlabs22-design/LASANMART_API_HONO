import { Hono } from 'hono';
import { pool } from '../db/pool.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { notifyStatusChange } from '../lib/notifications.js';
import { deleteVideo } from '../lib/cloudinary.js';
import { deletablePublicId, fileStillUsed } from '../lib/media.js';
import { notifyPartner } from '../lib/partnerNotify.js';
import { createNotification } from '../lib/notifications.js';

export const adminRoute = new Hono();

// Everything below this line requires the admin key
adminRoute.use('*', adminAuth);

const VALID_STATUSES = ['new', 'contacted', 'in_progress', 'closed'];
const VALID_ROLES = ['influencer', 'vendor', 'freelancer'];

/**
 * GET /admin/stats
 * The numbers along the top of the dashboard.
 */
adminRoute.get('/stats', async (c) => {
  try {
    const [requests, contacts, byType, workload] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'new')::int AS new,
          COUNT(*) FILTER (WHERE status = 'contacted')::int AS contacted,
          COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
          COUNT(*) FILTER (WHERE status = 'closed')::int AS closed,
          COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS this_week
        FROM requests
      `),
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS this_week
        FROM contacts
      `),
      pool.query(`
        SELECT type, COUNT(*)::int AS count
        FROM requests
        GROUP BY type
        ORDER BY count DESC
      `),
      // Who is carrying what, ignoring anything already closed
      pool.query(`
        SELECT assigned_to, COUNT(*)::int AS count
        FROM requests
        WHERE assigned_to IS NOT NULL AND status != 'closed'
        GROUP BY assigned_to
        ORDER BY count DESC
      `),
    ]);

    return c.json({
      requests: requests.rows[0],
      contacts: contacts.rows[0],
      byType: byType.rows,
      workload: workload.rows,
    });
  } catch (err) {
    console.error('Failed to load stats:', err);
    return c.json({ error: 'Could not load stats' }, 500);
  }
});

/**
 * GET /admin/assignees
 * Names already used, so the dashboard can suggest them and
 * cut down on "Ravi" vs "ravi" vs "Ravi Kumar".
 */
adminRoute.get('/assignees', async (c) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT assigned_to
      FROM requests
      WHERE assigned_to IS NOT NULL AND assigned_to != ''
      ORDER BY assigned_to
    `);

    return c.json({ assignees: result.rows.map((r) => r.assigned_to) });
  } catch (err) {
    console.error('Failed to load assignees:', err);
    return c.json({ error: 'Could not load assignees' }, 500);
  }
});

/**
 * GET /admin/requests?status=new&type=plan&assignedTo=Ravi&q=aaron&page=1
 * The main list, with filters and search.
 */
adminRoute.get('/requests', async (c) => {
  const status = c.req.query('status');
  const type = c.req.query('type');
  const assignedTo = c.req.query('assignedTo');
  const q = c.req.query('q');
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const limit = 25;
  const offset = (page - 1) * limit;

  // Build the WHERE clause piece by piece so we only filter on
  // what was actually asked for
  const conditions: string[] = [];
  const params: any[] = [];

  if (status && VALID_STATUSES.includes(status)) {
    params.push(status);
    conditions.push(`r.status = $${params.length}`);
  }

  if (type) {
    params.push(type);
    conditions.push(`r.type = $${params.length}`);
  }

  if (assignedTo) {
    if (assignedTo === 'unassigned') {
      conditions.push(`r.assigned_to IS NULL`);
    } else {
      params.push(assignedTo);
      conditions.push(`r.assigned_to = $${params.length}`);
    }
  }

  if (q) {
    params.push(`%${q}%`);
    const i = params.length;
    conditions.push(
      `(c.name ILIKE $${i} OR c.phone ILIKE $${i} OR c.email ILIKE $${i} OR r.title ILIKE $${i})`
    );
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
         FROM requests r
         JOIN contacts c ON c.id = r.contact_id
         ${where}`,
      params
    );

    const result = await pool.query(
      `SELECT
          r.id, r.type, r.title, r.description, r.details,
          r.status, r.assigned_to, r.assigned_at, r.internal_note,
          r.email_sent, r.created_at,
          c.id AS contact_id, c.name, c.phone, c.email,
          c.company_name, c.sector, c.city,
          -- Who's doing the work, if anyone
          (SELECT json_build_object(
              'partner_name', i2.name,
              'company_name', i2.company_name,
              'status', a2.status
            )
             FROM request_assignments a2
             JOIN influencers i2 ON i2.id = a2.partner_id
            WHERE a2.request_id = r.id
              AND a2.status IN ('offered','accepted','in_progress','completed')
            ORDER BY a2.assigned_at DESC
            LIMIT 1) AS assignment
        FROM requests r
        JOIN contacts c ON c.id = r.contact_id
        ${where}
        ORDER BY r.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    return c.json({
      requests: result.rows,
      total: countResult.rows[0].total,
      page,
      pages: Math.ceil(countResult.rows[0].total / limit),
    });
  } catch (err) {
    console.error('Failed to load requests:', err);
    return c.json({ error: 'Could not load requests' }, 500);
  }
});

/**
 * GET /admin/requests/:id
 * One request in full, for the detail view.
 */
adminRoute.get('/requests/:id', async (c) => {
  const id = c.req.param('id');

  try {
    const result = await pool.query(
      `SELECT
          r.id, r.type, r.title, r.description, r.details,
          r.status, r.assigned_to, r.assigned_at, r.internal_note,
          r.email_sent, r.created_at, r.updated_at,
          c.id AS contact_id, c.name, c.phone, c.email,
          c.company_name, c.company_description, c.sector, c.city,
          c.created_at AS contact_since,
                  -- Who has the work, how it's going, and what the client said
          (SELECT json_build_object(
              'id', a2.id,
              'partner_name', i2.name,
              'company_name', i2.company_name,
              'partner_phone', i2.phone,
              'status', a2.status,
              'decline_reason', a2.decline_reason,
              'assigned_at', a2.assigned_at,
              'verdict', f2.verdict,
              'comment', f2.comment
            )
             FROM request_assignments a2
             JOIN influencers i2 ON i2.id = a2.partner_id
             LEFT JOIN assignment_feedback f2 ON f2.assignment_id = a2.id
            WHERE a2.request_id = r.id
            ORDER BY a2.assigned_at DESC
            LIMIT 1) AS assignment
        FROM requests r
        JOIN contacts c ON c.id = r.contact_id
        WHERE r.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return c.json({ error: 'Request not found' }, 404);
    }

    return c.json({ request: result.rows[0] });
  } catch (err) {
    console.error('Failed to load request:', err);
    return c.json({ error: 'Could not load request' }, 500);
  }
});

/**
 * PATCH /admin/requests/:id
 * Update status, assignee, internal note — any combination.
 * A genuine status change also notifies the customer in the app.
 */
adminRoute.patch('/requests/:id', async (c) => {
  const id = c.req.param('id');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }

  const updates: string[] = [];
  const params: any[] = [];

  if (body.status !== undefined) {
    if (!VALID_STATUSES.includes(body.status)) {
      return c.json({ error: 'Invalid status' }, 400);
    }
    params.push(body.status);
    updates.push(`status = $${params.length}`);
  }

  if (body.assignedTo !== undefined) {
    const name = String(body.assignedTo).trim();
    params.push(name || null);
    updates.push(`assigned_to = $${params.length}`);
    // Stamp the time only when someone is actually assigned
    updates.push(name ? `assigned_at = now()` : `assigned_at = NULL`);
  }

  if (body.internalNote !== undefined) {
    params.push(String(body.internalNote).trim() || null);
    updates.push(`internal_note = $${params.length}`);
  }

  if (updates.length === 0) {
    return c.json({ error: 'Nothing to update' }, 400);
  }

  updates.push(`updated_at = now()`);
  params.push(id);

  try {
    // Read the current state first — we only notify the customer
    // when the status genuinely moves, not on every save
    const before = await pool.query(
      `SELECT status, title, contact_id FROM requests WHERE id = $1`,
      [id]
    );

    if (before.rows.length === 0) {
      return c.json({ error: 'Request not found' }, 404);
    }

    const previous = before.rows[0];

    const result = await pool.query(
      `UPDATE requests
          SET ${updates.join(', ')}
        WHERE id = $${params.length}
        RETURNING id, status, assigned_to, assigned_at, internal_note, updated_at`,
      params
    );

    const updated = result.rows[0];

    if (body.status !== undefined && body.status !== previous.status) {
      // Never throws — a failed notification must not fail the update
      await notifyStatusChange(
        previous.contact_id,
        id,
        body.status,
        previous.title
      );
    }

    return c.json({ success: true, request: updated });
  } catch (err) {
    console.error('Failed to update request:', err);
    return c.json({ error: 'Could not update request' }, 500);
  }
});

/**
 * GET /admin/contacts?q=aaron&page=1
 * Everyone who has ever submitted, with how many requests each has made.
 */
adminRoute.get('/contacts', async (c) => {
  const q = c.req.query('q');
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const limit = 50;
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: any[] = [];

  if (q) {
    params.push(`%${q}%`);
    const i = params.length;
    conditions.push(
      `(c.name ILIKE $${i} OR c.phone ILIKE $${i} OR c.email ILIKE $${i} OR c.company_name ILIKE $${i})`
    );
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM contacts c ${where}`,
      params
    );

    const result = await pool.query(
      `SELECT
          c.id, c.name, c.phone, c.email, c.company_name,
          c.sector, c.city, c.created_at,
          c.photo_url, c.logo_url,
          (c.push_token IS NOT NULL) AS push_enabled,
          COUNT(r.id)::int AS request_count,
          MAX(r.created_at) AS last_request_at
        FROM contacts c
        LEFT JOIN requests r ON r.contact_id = c.id
        ${where}
        GROUP BY c.id
        ORDER BY c.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    return c.json({
      contacts: result.rows,
      total: countResult.rows[0].total,
      page,
      pages: Math.ceil(countResult.rows[0].total / limit),
    });
  } catch (err) {
    console.error('Failed to load contacts:', err);
    return c.json({ error: 'Could not load contacts' }, 500);
  }
});

/* ---------------- Lasan Vibes ---------------- */

/**
 * GET /admin/reels
 * Everything, including hidden ones, for the console.
 */
adminRoute.get('/reels', async (c) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.video_url, r.thumbnail_url, r.public_id,
              r.caption, r.username, r.source, r.status,
              r.duration, r.view_count, r.sort_order, r.created_at,
              c.name AS contact_name, c.phone AS contact_phone
         FROM reels r
         LEFT JOIN contacts c ON c.id = r.contact_id
        ORDER BY r.sort_order DESC, r.created_at DESC
        LIMIT 200`
    );

    const counts = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'live')::int AS live,
        COUNT(*) FILTER (WHERE status = 'hidden')::int AS hidden,
        COUNT(*) FILTER (WHERE source = 'user')::int AS from_users,
        COALESCE(SUM(view_count), 0)::int AS total_views
      FROM reels
    `);

    return c.json({ reels: result.rows, stats: counts.rows[0] });
  } catch (err) {
    console.error('Failed to load reels:', err);
    return c.json({ error: 'Could not load reels' }, 500);
  }
});

/**
 * POST /admin/reels
 * The team posting a reel from the console.
 */
adminRoute.post('/reels', async (c) => {
  let body: any;

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }

  const videoUrl = String(body.videoUrl || '').trim();

  if (!videoUrl.startsWith('http')) {
    return c.json({ error: 'A video is required' }, 400);
  }

  const username = String(body.username || '@lasanmart').trim();

  try {
    const result = await pool.query(
      `INSERT INTO reels
        (video_url, thumbnail_url, public_id, duration,
         caption, username, source, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'team', 'live')
       RETURNING id, video_url, thumbnail_url, caption, username, created_at`,
      [
        videoUrl,
        body.thumbnailUrl || null,
        body.publicId || null,
        body.duration || null,
        body.caption ? String(body.caption).trim().slice(0, 300) : null,
        username.startsWith('@') ? username : `@${username}`,
      ]
    );

    return c.json({ success: true, reel: result.rows[0] }, 201);
  } catch (err) {
    console.error('Failed to create reel:', err);
    return c.json({ error: 'Could not save the reel' }, 500);
  }
});

/**
 * PATCH /admin/reels/:id
 * Edit the caption, hide it, or pin it to the top.
 */
adminRoute.patch('/reels/:id', async (c) => {
  const id = c.req.param('id');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }

  const updates: string[] = [];
  const params: any[] = [];

  if (body.caption !== undefined) {
    params.push(String(body.caption).trim().slice(0, 300) || null);
    updates.push(`caption = $${params.length}`);
  }

  if (body.status !== undefined) {
    if (!['live', 'pending', 'hidden'].includes(body.status)) {
      return c.json({ error: 'Invalid status' }, 400);
    }
    params.push(body.status);
    updates.push(`status = $${params.length}`);
  }

  if (body.sortOrder !== undefined) {
    params.push(Number(body.sortOrder) || 0);
    updates.push(`sort_order = $${params.length}`);
  }

  if (updates.length === 0) {
    return c.json({ error: 'Nothing to update' }, 400);
  }

  updates.push('updated_at = now()');
  params.push(id);

  try {
    const result = await pool.query(
      `UPDATE reels SET ${updates.join(', ')}
        WHERE id = $${params.length}
        RETURNING id, caption, status, sort_order`,
      params
    );

    if (result.rows.length === 0) {
      return c.json({ error: 'Reel not found' }, 404);
    }

    return c.json({ success: true, reel: result.rows[0] });
  } catch (err) {
    console.error('Failed to update reel:', err);
    return c.json({ error: 'Could not update the reel' }, 500);
  }
});

/**
 * DELETE /admin/reels/:id
 * Removes the row and the file from Cloudinary.
 */
adminRoute.delete('/reels/:id', async (c) => {
  const id = c.req.param('id');

  try {
    const existing = await pool.query(
      'SELECT public_id FROM reels WHERE id = $1',
      [id]
    );

    if (existing.rows.length === 0) {
      return c.json({ error: 'Reel not found' }, 404);
    }

    const publicId = existing.rows[0].public_id;

    await pool.query('DELETE FROM reels WHERE id = $1', [id]);

    // Free the storage. If this fails the row is already gone,
    // which is the right way round — a stray file is better than
    // a reel that won't disappear from the app.
    if (publicId) {
      await deleteVideo(publicId);
    }

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to delete reel:', err);
    return c.json({ error: 'Could not delete the reel' }, 500);
  }
});

/* ---------------- Data deletion ---------------- */

/**
 * GET /admin/contacts/:id/summary
 * What would be removed if this person were deleted.
 * Shown to the team before they confirm.
 */
adminRoute.get('/contacts/:id/summary', async (c) => {
  const id = c.req.param('id');

  try {
    const contact = await pool.query(
      'SELECT id, name, phone, email, created_at FROM contacts WHERE id = $1',
      [id]
    );

    if (contact.rows.length === 0) {
      return c.json({ error: 'Contact not found' }, 404);
    }

    const [requests, notifications, reels] = await Promise.all([
      pool.query(
        'SELECT COUNT(*)::int AS n FROM requests WHERE contact_id = $1',
        [id]
      ),
      pool.query(
        'SELECT COUNT(*)::int AS n FROM notifications WHERE contact_id = $1',
        [id]
      ),
      pool.query(
        'SELECT id, public_id, caption FROM reels WHERE contact_id = $1',
        [id]
      ),
    ]);

    return c.json({
      contact: contact.rows[0],
      counts: {
        requests: requests.rows[0].n,
        notifications: notifications.rows[0].n,
        reels: reels.rows.length,
      },
      reels: reels.rows,
    });
  } catch (err) {
    console.error('Failed to build deletion summary:', err);
    return c.json({ error: 'Could not load the summary' }, 500);
  }
});

/**
 * DELETE /admin/contacts/:id
 * Removes everything we hold about one person, for GDPR-style
 * deletion requests. Irreversible.
 *
 * Requires ?confirm=<their phone number> so a stray click can't
 * wipe someone.
 */
adminRoute.delete('/contacts/:id', async (c) => {
  const id = c.req.param('id');
  const confirm = (c.req.query('confirm') || '').replace(/\D/g, '');

  const client = await pool.connect();

  try {
    const existing = await client.query(
      'SELECT phone, name FROM contacts WHERE id = $1',
      [id]
    );

    if (existing.rows.length === 0) {
      return c.json({ error: 'Contact not found' }, 404);
    }

    const { phone, name } = existing.rows[0];

    if (confirm !== phone) {
      return c.json(
        { error: 'Confirmation does not match this contact’s phone number' },
        400
      );
    }

    // Collect the Cloudinary ids before the rows disappear
    const reels = await client.query(
      'SELECT public_id, video_url FROM reels WHERE contact_id = $1',
      [id]
    );

    await client.query('BEGIN');

    // Order matters where foreign keys don't cascade
    await client.query('DELETE FROM reel_likes WHERE contact_id = $1', [id]);
    await client.query('DELETE FROM notifications WHERE contact_id = $1', [id]);
    await client.query('DELETE FROM reels WHERE contact_id = $1', [id]);
    await client.query('DELETE FROM requests WHERE contact_id = $1', [id]);
    await client.query('DELETE FROM contacts WHERE id = $1', [id]);

    await client.query('COMMIT');

    // Free the video files. Done after the commit — a stray file is
    // better than a half-finished deletion.
    let filesRemoved = 0;
    for (const row of reels.rows) {
      // Only each reel's own file, and only if nothing else plays it —
      // older rows may carry an id the user typed in themselves
      const publicId = deletablePublicId(row);
      if (!publicId || (await fileStillUsed(publicId))) continue;

      if (await deleteVideo(publicId)) {
        filesRemoved += 1;
      }
    }

    console.log(
      `Deleted all data for ${name} (${phone}); ${filesRemoved} video(s) removed`
    );

    return c.json({ success: true, filesRemoved });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Failed to delete contact:', err);
    return c.json({ error: 'Could not delete this contact' }, 500);
  } finally {
    client.release();
  }
});

/**
 * DELETE /admin/requests/:id
 * Removes a single request — for duplicates and test data, rather
 * than a full deletion request.
 */
adminRoute.delete('/requests/:id', async (c) => {
  const id = c.req.param('id');

  try {
    const result = await pool.query(
      'DELETE FROM requests WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rows.length === 0) {
      return c.json({ error: 'Request not found' }, 404);
    }

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to delete request:', err);
    return c.json({ error: 'Could not delete the request' }, 500);
  }
});

/* ---------------- Partner onboarding ---------------- */

/**
 * GET /admin/influencers?status=pending&q=name
 * Creator applications, newest first. Pending come first by default,
 * since those are what need action.
 */
adminRoute.get('/influencers', async (c) => {
  const status = c.req.query('status');
  const role = c.req.query('role');
  const q = c.req.query('q');

  const conditions: string[] = [];
  const params: any[] = [];

  if (
    status &&
    ['pending', 'approved', 'rejected', 'paused'].includes(status)
  ) {
    params.push(status);
    conditions.push(`i.status = $${params.length}`);
  }

  if (role && VALID_ROLES.includes(role)) {
    params.push(role);
    conditions.push(`i.role = $${params.length}`);
  }

  if (q) {
    params.push(`%${q}%`);
    const n = params.length;
    conditions.push(
      `(i.name ILIKE $${n} OR i.phone ILIKE $${n} OR i.instagram_id ILIKE $${n}
        OR i.company_name ILIKE $${n})`
    );
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const [list, counts] = await Promise.all([
      pool.query(
        `SELECT i.id, i.phone, i.role, i.name, i.email, i.photo_url,
                i.instagram_id, i.followers, i.category, i.city, i.bio,
                i.rate_per_post, i.company_name, i.gst_number, i.services,
                i.other_service, i.portfolio_url, i.skills, i.rate_card,
                i.status, i.review_note, i.reviewed_at, i.created_at,
                COUNT(r.id)::int AS open_requests
           FROM influencers i
           LEFT JOIN influencer_requests r
             ON r.influencer_id = i.id AND r.status != 'closed'
           ${where}
          GROUP BY i.id
          ORDER BY
            CASE i.status WHEN 'pending' THEN 0 ELSE 1 END,
            i.created_at DESC
          LIMIT 200`,
        params
      ),
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
          COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
          COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
          COUNT(*) FILTER (WHERE role = 'influencer')::int AS influencers,
          COUNT(*) FILTER (WHERE role = 'vendor')::int AS vendors,
          COUNT(*) FILTER (WHERE role = 'freelancer')::int AS freelancers
        FROM influencers
      `),
    ]);

    return c.json({ influencers: list.rows, stats: counts.rows[0] });
  } catch (err) {
    console.error('Failed to load partners:', err);
    return c.json({ error: 'Could not load partners' }, 500);
  }
});

/**
 * PATCH /admin/influencers/:id
 * Approve, reject, pause, or leave a note.
 */
adminRoute.patch('/influencers/:id', async (c) => {
  const id = c.req.param('id');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }

  const updates: string[] = [];
  const params: any[] = [];

  if (body.status !== undefined) {
    if (!['pending', 'approved', 'rejected', 'paused'].includes(body.status)) {
      return c.json({ error: 'Invalid status' }, 400);
    }
    params.push(body.status);
    updates.push(`status = $${params.length}`);
    updates.push(`reviewed_at = now()`);
  }

  if (body.reviewNote !== undefined) {
    params.push(String(body.reviewNote).trim() || null);
    updates.push(`review_note = $${params.length}`);
  }

  // The team can correct a rate the creator entered wrongly
  if (body.ratePerPost !== undefined) {
    params.push(Number(body.ratePerPost) || null);
    updates.push(`rate_per_post = $${params.length}`);
  }

  if (updates.length === 0) {
    return c.json({ error: 'Nothing to update' }, 400);
  }

  updates.push('updated_at = now()');
  params.push(id);

  try {
    const result = await pool.query(
      `UPDATE influencers SET ${updates.join(', ')}
        WHERE id = $${params.length}
        RETURNING id, name, status, review_note, rate_per_post`,
      params
    );

    if (result.rows.length === 0) {
      return c.json({ error: 'Creator not found' }, 404);
    }

    if (body.status === 'approved') {
      await notifyPartner(id, {
        type: 'profile',
        title: "You're approved",
        body: "Your profile is live. When a client needs what you offer, we'll send it your way.",
      });
    }

    if (body.status === 'rejected') {
      await notifyPartner(id, {
        type: 'profile',
        title: 'We need a few changes',
        body:
          body.reviewNote ||
          'Have a look at your profile and resubmit when you can.',
      });
    }

    return c.json({ success: true, influencer: result.rows[0] });
  } catch (err) {
    console.error('Failed to update creator:', err);
    return c.json({ error: 'Could not update this creator' }, 500);
  }
});

/**
 * DELETE /admin/influencers/:id
 * Removes the application and everything they've asked us.
 */
adminRoute.delete('/influencers/:id', async (c) => {
  const id = c.req.param('id');

  try {
    const result = await pool.query(
      'DELETE FROM influencers WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rows.length === 0) {
      return c.json({ error: 'Creator not found' }, 404);
    }

    // influencer_requests cascades on delete
    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to delete creator:', err);
    return c.json({ error: 'Could not delete this creator' }, 500);
  }
});

/**
 * GET /admin/influencer-requests
 * What creators have asked us for.
 */
adminRoute.get('/influencer-requests', async (c) => {
  const status = c.req.query('status');

  const conditions: string[] = [];
  const params: any[] = [];

  if (
    status &&
    ['new', 'contacted', 'in_progress', 'closed'].includes(status)
  ) {
    params.push(status);
    conditions.push(`r.status = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await pool.query(
      `SELECT r.id, r.type, r.subject, r.message, r.status,
              r.internal_note, r.created_at,
              i.id AS influencer_id, i.name, i.phone, i.instagram_id,
              i.photo_url, i.role
         FROM influencer_requests r
         JOIN influencers i ON i.id = r.influencer_id
         ${where}
        ORDER BY r.created_at DESC
        LIMIT 100`,
      params
    );

    return c.json({ requests: result.rows });
  } catch (err) {
    console.error('Failed to load creator requests:', err);
    return c.json({ error: 'Could not load requests' }, 500);
  }
});

/**
 * PATCH /admin/influencer-requests/:id
 */
adminRoute.patch('/influencer-requests/:id', async (c) => {
  const id = c.req.param('id');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }

  const updates: string[] = [];
  const params: any[] = [];

  if (body.status !== undefined) {
    if (!['new', 'contacted', 'in_progress', 'closed'].includes(body.status)) {
      return c.json({ error: 'Invalid status' }, 400);
    }
    params.push(body.status);
    updates.push(`status = $${params.length}`);
  }

  if (body.internalNote !== undefined) {
    params.push(String(body.internalNote).trim() || null);
    updates.push(`internal_note = $${params.length}`);
  }

  if (updates.length === 0) {
    return c.json({ error: 'Nothing to update' }, 400);
  }

  updates.push('updated_at = now()');
  params.push(id);

  try {
    const result = await pool.query(
      `UPDATE influencer_requests SET ${updates.join(', ')}
        WHERE id = $${params.length}
        RETURNING id, status, internal_note`,
      params
    );

    if (result.rows.length === 0) {
      return c.json({ error: 'Request not found' }, 404);
    }

    return c.json({ success: true, request: result.rows[0] });
  } catch (err) {
    console.error('Failed to update creator request:', err);
    return c.json({ error: 'Could not update the request' }, 500);
  }
});

/* ---------------- Assigning work to vendors ---------------- */

/**
 * GET /admin/requests/:id/assign
 * Everything the team needs to place this request: the request itself,
 * approved vendors/freelancers who offer the service or skill, and
 * who already has it.
 */
adminRoute.get('/requests/:id/assign', async (c) => {
  const requestId = c.req.param('id');

  try {
    const reqRow = await pool.query(
      `SELECT r.id, r.type, r.title, r.description, r.details, r.status,
              c.name AS customer_name, c.phone AS customer_phone,
              c.city AS customer_city
         FROM requests r
         JOIN contacts c ON c.id = r.contact_id
        WHERE r.id = $1`,
      [requestId]
    );

    if (reqRow.rows.length === 0) {
      return c.json({ error: 'Request not found' }, 404);
    }

    const request = reqRow.rows[0];
    const service =
      request.details?.service || request.details?.services?.[0] || null;

    /* Which kind of partner can do this. An influencer request names
       people directly; everything else is matched on services or skills,
       so listing all three roles just clutters the choice. */
    const roleFilter =
      request.type === 'influencer'
        ? `i.role = 'influencer'`
        : `i.role IN ('vendor', 'freelancer')`;

    // Approved vendors and freelancers, those who offer this exact
    // service/skill first
    const vendors = await pool.query(
      `SELECT i.id, i.name, i.phone, i.company_name, i.photo_url,
              i.services, i.skills, i.role, i.city, i.rate_card, i.gst_number,
              COUNT(a.id) FILTER (WHERE a.status IN ('accepted','in_progress'))::int
                AS active_jobs,
              COUNT(f.id) FILTER (WHERE f.verdict = 'good')::int AS good_jobs,
              COUNT(f.id)::int AS rated_jobs,
              CASE WHEN $1::text IS NULL THEN false
                   WHEN i.role = 'vendor' THEN i.services @> to_jsonb(ARRAY[$1::text])
                   WHEN i.role = 'freelancer' THEN i.skills @> to_jsonb(ARRAY[$1::text])
                   ELSE i.category = $1::text
              END AS offers_this
         FROM influencers i
         LEFT JOIN request_assignments a ON a.partner_id = i.id
         LEFT JOIN assignment_feedback f ON f.partner_id = i.id
        WHERE i.status = 'approved' AND ${roleFilter}
        GROUP BY i.id
        ORDER BY offers_this DESC, good_jobs DESC, i.created_at DESC`,
      [service]
    );

    const existing = await pool.query(
      `SELECT a.*, i.name, i.company_name, i.phone, i.photo_url,
              f.verdict, f.comment
         FROM request_assignments a
         JOIN influencers i ON i.id = a.partner_id
         LEFT JOIN assignment_feedback f ON f.assignment_id = a.id
        WHERE a.request_id = $1
        ORDER BY a.assigned_at DESC`,
      [requestId]
    );

    /* For an influencer request, the customer already chose. Pull their
       names out of details so the panel can show exactly those people
       first, rather than a list the team has to match by eye. */
    const pickedNames: string[] = Array.isArray(request.details?.creators)
      ? request.details.creators.map((line: string) =>
          String(line).split('(')[0].split('—')[0].trim()
        )
      : [];

    return c.json({
      request,
      service,
      pickedNames,
      vendors: vendors.rows,
      assignments: existing.rows,
    });
  } catch (err) {
    console.error('Failed to load assignment view:', err);
    return c.json({ error: 'Could not load vendors' }, 500);
  }
});

/**
 * POST /admin/requests/:id/assign
 * Body: { partnerId, brief? }
 */
adminRoute.post('/requests/:id/assign', async (c) => {
  const requestId = c.req.param('id');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }

  if (!body.partnerId) {
    return c.json({ error: 'Pick a vendor' }, 400);
  }

  try {
    const result = await pool.query(
      `INSERT INTO request_assignments (request_id, partner_id, brief)
       VALUES ($1, $2, $3)
       ON CONFLICT (request_id, partner_id) DO UPDATE SET
         status = 'offered',
         brief = EXCLUDED.brief,
         decline_reason = NULL,
         assigned_at = now(),
         responded_at = NULL
       RETURNING id, status`,
      [
        requestId,
        body.partnerId,
        body.brief ? String(body.brief).trim().slice(0, 1000) : null,
      ]
    );

    // Move the request along, so the team can see it's been placed
    await pool
      .query(
        `UPDATE requests SET status = 'in_progress', updated_at = now()
          WHERE id = $1 AND status = 'new'`,
        [requestId]
      )
      .catch(() => {});

    // Let them know there's work waiting
    const req = await pool.query('SELECT details FROM requests WHERE id = $1', [
      requestId,
    ]);

    const service =
      req.rows[0]?.details?.service || req.rows[0]?.details?.services?.[0];

    await notifyPartner(body.partnerId, {
      assignmentId: result.rows[0].id,
      type: 'work',
      title: 'New work for you',
      body: service
        ? `A client needs ${service}. Open the Work tab to see the details and accept it.`
        : 'A client needs your help. Open the Work tab to see the details.',
    });

    return c.json({ success: true, assignment: result.rows[0] }, 201);
  } catch (err) {
    console.error('Failed to assign:', err);
    return c.json({ error: 'Could not assign this vendor' }, 500);
  }
});

/**
 * PATCH /admin/assignments/:id
 * Withdraw, or record what a vendor said on the phone.
 */
adminRoute.patch('/assignments/:id', async (c) => {
  const id = c.req.param('id');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }

  const valid = [
    'offered',
    'accepted',
    'declined',
    'in_progress',
    'completed',
    'withdrawn',
  ];

  const updates: string[] = [];
  const params: any[] = [];

  if (body.status !== undefined) {
    if (!valid.includes(body.status)) {
      return c.json({ error: 'Invalid status' }, 400);
    }
    params.push(body.status);
    updates.push(`status = $${params.length}`);
    updates.push('responded_at = now()');

    if (body.status === 'completed') {
      updates.push('completed_at = now()');
    }
  }

  if (body.partnerNote !== undefined) {
    params.push(String(body.partnerNote).trim() || null);
    updates.push(`partner_note = $${params.length}`);
  }

  if (updates.length === 0) {
    return c.json({ error: 'Nothing to update' }, 400);
  }

  params.push(id);

  try {
    const result = await pool.query(
      `UPDATE request_assignments SET ${updates.join(', ')}
        WHERE id = $${params.length}
        RETURNING id, status`,
      params
    );

    if (result.rows.length === 0) {
      return c.json({ error: 'Assignment not found' }, 404);
    }

    return c.json({ success: true, assignment: result.rows[0] });
  } catch (err) {
    console.error('Failed to update assignment:', err);
    return c.json({ error: 'Could not update' }, 500);
  }
});

/**
 * GET /admin/work
 * Every live assignment across all requests — the answer to
 * "what are we actually working on right now?"
 */
adminRoute.get('/work', async (c) => {
  const status = c.req.query('status');

  const conditions: string[] = [];
  const params: any[] = [];

  if (
    status &&
    ['offered', 'accepted', 'in_progress', 'completed'].includes(status)
  ) {
    params.push(status);
    conditions.push(`a.status = $${params.length}`);
  } else {
    // Everything still open, by default
    conditions.push(`a.status IN ('offered','accepted','in_progress')`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  try {
    const [list, counts] = await Promise.all([
      pool.query(
        `SELECT a.id, a.status, a.brief, a.decline_reason,
                a.assigned_at, a.responded_at, a.completed_at,
                r.id AS request_id, r.title, r.type, r.details,
                c.name AS customer_name, c.phone AS customer_phone,
                c.city AS customer_city,
                i.id AS partner_id, i.name AS partner_name,
                i.company_name, i.phone AS partner_phone,
                i.photo_url AS partner_photo, i.role AS partner_role,
                f.verdict, f.comment
           FROM request_assignments a
           JOIN requests r ON r.id = a.request_id
           JOIN contacts c ON c.id = r.contact_id
           JOIN influencers i ON i.id = a.partner_id
           LEFT JOIN assignment_feedback f ON f.assignment_id = a.id
           ${where}
          ORDER BY
            CASE a.status WHEN 'offered' THEN 0
                          WHEN 'in_progress' THEN 1
                          WHEN 'accepted' THEN 2
                          ELSE 3 END,
            a.assigned_at DESC
          LIMIT 200`,
        params
      ),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'offered')::int AS offered,
          COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
          COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
          COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
          COUNT(*) FILTER (WHERE status = 'declined')::int AS declined
        FROM request_assignments
      `),
    ]);

    return c.json({ work: list.rows, stats: counts.rows[0] });
  } catch (err) {
    console.error('Failed to load work:', err);
    return c.json({ error: 'Could not load work' }, 500);
  }
});

/* ---------------- Lasan Vibes access ---------------- */

/**
 * GET /admin/vibes-access
 * Who has asked to post, and who already can.
 */
adminRoute.get('/vibes-access', async (c) => {
  try {
    const [pending, approved] = await Promise.all([
      pool.query(
        `SELECT id, name, phone, email, company_name, sector, city,
                photo_url, vibes_requested_at, vibes_reason
           FROM contacts
          WHERE vibes_requested_at IS NOT NULL AND can_post_vibes = false
          ORDER BY vibes_requested_at DESC`
      ),
      pool.query(
        `SELECT c.id, c.name, c.phone, c.company_name, c.photo_url,
                c.vibes_decided_at,
                COUNT(r.id)::int AS reels_posted
           FROM contacts c
           LEFT JOIN reels r ON r.contact_id = c.id
          WHERE c.can_post_vibes = true
          GROUP BY c.id
          ORDER BY c.vibes_decided_at DESC NULLS LAST`
      ),
    ]);

    return c.json({ pending: pending.rows, approved: approved.rows });
  } catch (err) {
    console.error('Failed to load vibes access:', err);
    return c.json({ error: 'Could not load requests' }, 500);
  }
});

/**
 * PATCH /admin/vibes-access/:id
 * Body: { grant: true | false }
 */
adminRoute.patch('/vibes-access/:id', async (c) => {
  const id = c.req.param('id');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }

  const grant = body.grant === true;

  try {
    const result = await pool.query(
      `UPDATE contacts SET
         can_post_vibes = $1,
         vibes_decided_at = now(),
         updated_at = now()
       WHERE id = $2
       RETURNING id, name, can_post_vibes`,
      [grant, id]
    );

    if (result.rows.length === 0) {
      return c.json({ error: 'Person not found' }, 404);
    }

    // Tell them either way — silence is worse than a no
    await createNotification(id, {
      type: 'status',
      title: grant ? 'You can post to Lasan Vibes' : 'About your Vibes request',
      body: grant
        ? 'Your request was approved. Open Lasan Vibes and tap the plus to share your first video.'
        : "We're not able to open posting for this account at the moment. Message our team if you'd like to talk it through.",
    }).catch(() => {});

    return c.json({ success: true, contact: result.rows[0] });
  } catch (err) {
    console.error('Failed to update vibes access:', err);
    return c.json({ error: 'Could not update' }, 500);
  }
});
