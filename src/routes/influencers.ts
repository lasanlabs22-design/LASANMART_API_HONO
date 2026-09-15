import { Hono } from 'hono';
import { pool } from '../db/pool.js';
import { requirePhone } from '../middleware/requirePhone.js';
import { createNotification } from '../lib/notifications.js';

export const influencersRoute = new Hono<{ Variables: { phone: string } }>();

const VALID_REQUEST_TYPES = [
  'general',
  'payment',
  'profile',
  'availability',
  'complaint',
];

const VALID_ROLES = ['influencer', 'vendor', 'freelancer'];

/**
 * GET /influencers/me
 * This partner's own profile, or null if they haven't made one.
 * The app checks this on launch to decide which screen to show.
 */
influencersRoute.get('/me', requirePhone, async (c) => {
  const phone = c.get('phone');

  try {
    const result = await pool.query(
      `SELECT id, phone, role, name, email, photo_url,
              instagram_id, followers, category, city, bio, rate_per_post,
              company_name, gst_number, services, other_service,
              portfolio_url, skills, rate_card,
              status, review_note, created_at
         FROM influencers
        WHERE phone = $1`,
      [phone]
    );

    return c.json({ influencer: result.rows[0] || null });
  } catch (err) {
    console.error('Failed to load partner profile:', err);
    return c.json({ error: 'Could not load your profile' }, 500);
  }
});

/**
 * POST /influencers
 * Create or update a partner profile — influencer, vendor or freelancer.
 *
 * Editing an approved profile sends it back to pending, so nobody gets
 * approved on modest rates and then quietly changes them.
 */
influencersRoute.post('/', requirePhone, async (c) => {
  const phone = c.get('phone');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }

  const role = VALID_ROLES.includes(body.role) ? body.role : 'influencer';

  const name = String(body.name || '').trim();
  if (name.length < 2) {
    return c.json({ error: 'Please enter your name' }, 400);
  }

  /* What each role must supply before we'll take it seriously */

  const instagram = body.instagramId
    ? String(body.instagramId).trim().replace(/^@/, '')
    : null;

  if (role === 'influencer' && !instagram) {
    return c.json({ error: 'Instagram handle is required' }, 400);
  }

  if (role === 'vendor') {
    if (!String(body.companyName || '').trim()) {
      return c.json({ error: 'Company name is required' }, 400);
    }
    if (!Array.isArray(body.services) || body.services.length === 0) {
      return c.json({ error: 'Pick at least one service you offer' }, 400);
    }
  }

  if (role === 'freelancer') {
    if (!Array.isArray(body.skills) || body.skills.length === 0) {
      return c.json({ error: 'Pick at least one skill' }, 400);
    }
  }

  const email = body.email ? String(body.email).trim().toLowerCase() : null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'Email is not valid' }, 400);
  }

  const rate = body.ratePerPost ? Number(body.ratePerPost) : null;
  if (rate !== null && (isNaN(rate) || rate < 0)) {
    return c.json({ error: 'Rate must be a number' }, 400);
  }

  try {
    const result = await pool.query(
      `INSERT INTO influencers
        (phone, role, name, email, photo_url,
         instagram_id, followers, category, city, bio, rate_per_post,
         company_name, gst_number, services, other_service,
         portfolio_url, skills, rate_card, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               $12, $13, $14, $15, $16, $17, $18, 'pending')
             ON CONFLICT (phone) DO UPDATE SET
         role = EXCLUDED.role,
         name = EXCLUDED.name,
         email = EXCLUDED.email,
         photo_url = EXCLUDED.photo_url,
         instagram_id = EXCLUDED.instagram_id,
         followers = EXCLUDED.followers,
         category = EXCLUDED.category,
         city = EXCLUDED.city,
         bio = EXCLUDED.bio,
         rate_per_post = EXCLUDED.rate_per_post,
         company_name = EXCLUDED.company_name,
         gst_number = EXCLUDED.gst_number,
         services = EXCLUDED.services,
         other_service = EXCLUDED.other_service,
         portfolio_url = EXCLUDED.portfolio_url,
         skills = EXCLUDED.skills,
         rate_card = EXCLUDED.rate_card,
         -- Any edit needs looking at again
         status = 'pending',
         review_note = NULL,
         updated_at = now()
       RETURNING id, role, status`,
      [
        phone,
        role,
        name,
        email,
        body.photoUrl || null,
        instagram,
        body.followers || null,
        body.category || null,
        body.city || null,
        body.bio ? String(body.bio).trim().slice(0, 500) : null,
        rate,
        body.companyName ? String(body.companyName).trim() : null,
        body.gstNumber ? String(body.gstNumber).trim().toUpperCase() : null,
        Array.isArray(body.services) ? JSON.stringify(body.services) : null,
        body.otherService ? String(body.otherService).trim() : null,
        body.portfolioUrl ? String(body.portfolioUrl).trim() : null,
        Array.isArray(body.skills) ? JSON.stringify(body.skills) : null,
        body.rateCard ? String(body.rateCard).trim().slice(0, 500) : null,
      ]
    );

    return c.json({ success: true, partner: result.rows[0] }, 201);
  } catch (err) {
    console.error('Failed to save partner profile:', err);
    return c.json({ error: 'Could not save your profile' }, 500);
  }
});

/**
 * GET /influencers/requests
 * Everything this partner has asked us, newest first.
 */
influencersRoute.get('/requests', requirePhone, async (c) => {
  const phone = c.get('phone');

  try {
    const result = await pool.query(
      `SELECT r.id, r.type, r.subject, r.message, r.status, r.created_at
         FROM influencer_requests r
         JOIN influencers i ON i.id = r.influencer_id
        WHERE i.phone = $1
        ORDER BY r.created_at DESC
        LIMIT 100`,
      [phone]
    );

    return c.json({ requests: result.rows });
  } catch (err) {
    console.error('Failed to load partner requests:', err);
    return c.json({ error: 'Could not load your requests' }, 500);
  }
});

/**
 * POST /influencers/requests
 * A partner raising something with our team.
 */
influencersRoute.post('/requests', requirePhone, async (c) => {
  const phone = c.get('phone');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }

  const message = String(body.message || '').trim();
  if (message.length < 5) {
    return c.json({ error: 'Please tell us a bit more' }, 400);
  }

  const type = VALID_REQUEST_TYPES.includes(body.type) ? body.type : 'general';

  try {
    const partner = await pool.query(
      'SELECT id FROM influencers WHERE phone = $1',
      [phone]
    );

    if (partner.rows.length === 0) {
      return c.json({ error: 'Create your profile first' }, 403);
    }

    const result = await pool.query(
      `INSERT INTO influencer_requests
        (influencer_id, type, subject, message)
       VALUES ($1, $2, $3, $4)
       RETURNING id, type, subject, message, status, created_at`,
      [
        partner.rows[0].id,
        type,
        body.subject ? String(body.subject).trim().slice(0, 120) : null,
        message.slice(0, 1000),
      ]
    );

    return c.json({ success: true, request: result.rows[0] }, 201);
  } catch (err) {
    console.error('Failed to create partner request:', err);
    return c.json({ error: 'Could not send your request' }, 500);
  }
});

/* ---------------- Work assigned to this partner ---------------- */

/**
 * GET /influencers/work
 * Everything offered to this partner, newest first.
 *
 * The customer's contact details are deliberately withheld — the
 * partner sees the job and the city, and talks to us about anything
 * else. That's what keeps us in the middle of the relationship.
 */
influencersRoute.get('/work', requirePhone, async (c) => {
  const phone = c.get('phone');

  try {
    const result = await pool.query(
      `SELECT a.id, a.status, a.brief, a.decline_reason, a.partner_note,
              a.assigned_at, a.responded_at, a.completed_at,
                           r.type, r.title, r.description, r.details,
              c.city, c.name AS customer_name
         FROM request_assignments a
         JOIN influencers i ON i.id = a.partner_id
         JOIN requests r ON r.id = a.request_id
         JOIN contacts c ON c.id = r.contact_id
        WHERE i.phone = $1
        ORDER BY
          CASE a.status WHEN 'offered' THEN 0
                        WHEN 'accepted' THEN 1
                        WHEN 'in_progress' THEN 2
                        ELSE 3 END,
          a.assigned_at DESC
        LIMIT 100`,
      [phone]
    );

    // Only the first name reaches them — "Aaron", not "Aaron Amit Birru"
    const jobs = result.rows.map((r) => ({
      ...r,
      customer_name: String(r.customer_name || '').split(' ')[0],
    }));

    return c.json({ jobs });
  } catch (err) {
    console.error('Failed to load assigned work:', err);
    return c.json({ error: 'Could not load your work' }, 500);
  }
});

/**
 * PATCH /influencers/work/:id
 * The partner accepting, declining, starting or finishing a job.
 *
 * Ownership is checked in the query — a partner can only touch
 * assignments that are theirs.
 */
influencersRoute.patch('/work/:id', requirePhone, async (c) => {
  const id = c.req.param('id');
  const phone = c.get('phone');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }

  // What a partner is allowed to set themselves
  const allowed = ['accepted', 'declined', 'in_progress', 'completed'];

  if (!allowed.includes(body.status)) {
    return c.json({ error: 'Invalid status' }, 400);
  }

  if (body.status === 'declined' && !String(body.reason || '').trim()) {
    return c.json({ error: 'Please tell us why' }, 400);
  }

  try {
    const result = await pool.query(
      `UPDATE request_assignments a
          SET status = $1,
              decline_reason = CASE WHEN $1 = 'declined' THEN $2 ELSE a.decline_reason END,
              partner_note = COALESCE($3, a.partner_note),
              responded_at = now(),
              completed_at = CASE WHEN $1 = 'completed' THEN now() ELSE a.completed_at END
         FROM influencers i
        WHERE a.id = $4
          AND a.partner_id = i.id
          AND i.phone = $5
        RETURNING a.id, a.status, a.request_id`,
      [
        body.status,
        body.reason ? String(body.reason).trim().slice(0, 500) : null,
        body.note ? String(body.note).trim().slice(0, 500) : null,
        id,
        phone,
      ]
    );

    if (result.rows.length === 0) {
      return c.json({ error: 'Job not found' }, 404);
    }

    // Tell the customer when it's done
    if (body.status === 'completed') {
      const req = await pool.query(
        'SELECT contact_id, title FROM requests WHERE id = $1',
        [result.rows[0].request_id]
      );

      if (req.rows[0]) {
        await createNotification(req.rows[0].contact_id, {
          requestId: result.rows[0].request_id,
          type: 'status',
          title: 'Work completed',
          body: `Our partner has finished the work on "${req.rows[0].title || 'your request'}". We'll be in touch to check you're happy with it.`,
        }).catch(() => {});
      }
    }

    return c.json({ success: true, job: result.rows[0] });
  } catch (err) {
    console.error('Failed to update job:', err);
    return c.json({ error: 'Could not update this job' }, 500);
  }
});
