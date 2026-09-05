import { Hono } from 'hono';
import { pool } from '../db/pool.js';
import { requirePhone } from '../middleware/requirePhone.js';

export const influencersRoute = new Hono<{ Variables: { phone: string } }>();

const VALID_REQUEST_TYPES = [
  'general',
  'payment',
  'profile',
  'availability',
  'complaint',
];

/**
 * GET /influencers/me
 * The creator's own profile, or null if they haven't created one.
 * This is what the app checks on launch to decide which screen to show.
 */
influencersRoute.get('/me', requirePhone, async (c) => {
  const phone = c.get('phone');

  try {
    const result = await pool.query(
      `SELECT id, phone, name, email, photo_url, instagram_id, followers,
              category, city, bio, rate_per_post, status, review_note,
              created_at
         FROM influencers
        WHERE phone = $1`,
      [phone]
    );

    return c.json({ influencer: result.rows[0] || null });
  } catch (err) {
    console.error('Failed to load creator profile:', err);
    return c.json({ error: 'Could not load your profile' }, 500);
  }
});

/**
 * POST /influencers
 * Create or update the creator's own profile.
 *
 * Editing an approved profile sends it back to pending — otherwise
 * someone could get approved with modest rates then quietly change them.
 */
influencersRoute.post('/', requirePhone, async (c) => {
  const phone = c.get('phone');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }

  const name = String(body.name || '').trim();
  if (name.length < 2) {
    return c.json({ error: 'Please enter your name' }, 400);
  }

  const instagram = String(body.instagramId || '')
    .trim()
    .replace(/^@/, '');

  if (!instagram) {
    return c.json({ error: 'Instagram handle is required' }, 400);
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
        (phone, name, email, photo_url, instagram_id, followers,
         category, city, bio, rate_per_post, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
       ON CONFLICT (phone) DO UPDATE SET
         name = EXCLUDED.name,
         email = COALESCE(EXCLUDED.email, influencers.email),
         photo_url = COALESCE(EXCLUDED.photo_url, influencers.photo_url),
         instagram_id = EXCLUDED.instagram_id,
         followers = COALESCE(EXCLUDED.followers, influencers.followers),
         category = COALESCE(EXCLUDED.category, influencers.category),
         city = COALESCE(EXCLUDED.city, influencers.city),
         bio = COALESCE(EXCLUDED.bio, influencers.bio),
         rate_per_post = COALESCE(EXCLUDED.rate_per_post, influencers.rate_per_post),
         -- Any edit needs looking at again
         status = 'pending',
         review_note = NULL,
         updated_at = now()
       RETURNING id, status`,
      [
        phone,
        name,
        email,
        body.photoUrl || null,
        instagram,
        body.followers || null,
        body.category || null,
        body.city || null,
        body.bio ? String(body.bio).trim().slice(0, 500) : null,
        rate,
      ]
    );

    return c.json({ success: true, influencer: result.rows[0] }, 201);
  } catch (err) {
    console.error('Failed to save creator profile:', err);
    return c.json({ error: 'Could not save your profile' }, 500);
  }
});

/**
 * GET /influencers/requests
 * Everything this creator has asked us, newest first.
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
    console.error('Failed to load creator requests:', err);
    return c.json({ error: 'Could not load your requests' }, 500);
  }
});

/**
 * POST /influencers/requests
 * A creator raising something with our team.
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
    const creator = await pool.query(
      'SELECT id FROM influencers WHERE phone = $1',
      [phone]
    );

    if (creator.rows.length === 0) {
      return c.json({ error: 'Create your profile first' }, 403);
    }

    const result = await pool.query(
      `INSERT INTO influencer_requests
        (influencer_id, type, subject, message)
       VALUES ($1, $2, $3, $4)
       RETURNING id, type, subject, message, status, created_at`,
      [
        creator.rows[0].id,
        type,
        body.subject ? String(body.subject).trim().slice(0, 120) : null,
        message.slice(0, 1000),
      ]
    );

    return c.json({ success: true, request: result.rows[0] }, 201);
  } catch (err) {
    console.error('Failed to create creator request:', err);
    return c.json({ error: 'Could not send your request' }, 500);
  }
});
