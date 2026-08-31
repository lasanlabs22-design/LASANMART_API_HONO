import { Hono } from 'hono';
import { pool } from '../db/pool.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { notifyStatusChange } from '../lib/notifications.js';
import { deleteVideo } from '../lib/cloudinary.js';

export const adminRoute = new Hono();

// Everything below this line requires the admin key
adminRoute.use('*', adminAuth);

const VALID_STATUSES = ['new', 'contacted', 'in_progress', 'closed'];

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
          c.company_name, c.sector, c.city
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
          c.created_at AS contact_since
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
