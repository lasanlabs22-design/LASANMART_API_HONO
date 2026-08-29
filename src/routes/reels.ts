import { Hono } from 'hono';
import { pool } from '../db/pool.js';

export const reelsRoute = new Hono();

function normalisePhone(input: unknown): string {
  const digits = String(input ?? '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/**
 * GET /reels
 * The feed the app shows. Only live reels, newest first,
 * with pinned ones (higher sort_order) at the top.
 */
reelsRoute.get('/', async (c) => {
  const limit = Math.min(50, Number(c.req.query('limit')) || 30);

  try {
    const result = await pool.query(
      `SELECT id, video_url, thumbnail_url, caption, username,
              source, duration, view_count, created_at
         FROM reels
        WHERE status = 'live'
        ORDER BY sort_order DESC, created_at DESC
        LIMIT $1`,
      [limit]
    );

    return c.json({ reels: result.rows });
  } catch (err) {
    console.error('Failed to load reels:', err);
    return c.json({ error: 'Could not load reels' }, 500);
  }
});

/**
 * GET /reels/mine?phone=9876543210
 * Everything this person has posted, including anything the team
 * has hidden — so they can see it's still there.
 */
reelsRoute.get('/mine', async (c) => {
  const phone = normalisePhone(c.req.query('phone'));

  if (phone.length !== 10) {
    return c.json({ error: 'A valid 10-digit phone is required' }, 400);
  }

  try {
    const result = await pool.query(
      `SELECT r.id, r.video_url, r.thumbnail_url, r.caption, r.username,
              r.source, r.status, r.duration, r.view_count, r.created_at
         FROM reels r
         JOIN contacts c ON c.id = r.contact_id
        WHERE c.phone = $1
        ORDER BY r.created_at DESC
        LIMIT 100`,
      [phone]
    );

    const views = result.rows.reduce((sum, r) => sum + (r.view_count || 0), 0);

    return c.json({
      reels: result.rows,
      total: result.rows.length,
      totalViews: views,
    });
  } catch (err) {
    console.error('Failed to load your reels:', err);
    return c.json({ error: 'Could not load your reels' }, 500);
  }
});

/**
 * POST /reels
 * A user posting from the app. The video is already on Cloudinary —
 * the app uploads there directly and sends us the URLs.
 *
 * Body: { videoUrl, thumbnailUrl?, publicId?, duration?, caption?, phone }
 */
reelsRoute.post('/', async (c) => {
  let body: any;

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }

  const videoUrl = String(body.videoUrl || '').trim();
  const phone = normalisePhone(body.phone);

  if (!videoUrl.startsWith('http')) {
    return c.json({ error: 'A valid video URL is required' }, 400);
  }

  if (phone.length !== 10) {
    return c.json({ error: 'A valid 10-digit phone is required' }, 400);
  }

  try {
    // Who is posting? We only accept reels from people we already know
    const contact = await pool.query(
      'SELECT id, name FROM contacts WHERE phone = $1',
      [phone]
    );

    if (contact.rows.length === 0) {
      return c.json(
        { error: 'Complete your profile before posting a reel' },
        403
      );
    }

    const { id: contactId, name } = contact.rows[0];

    // A readable handle from their name: "Aaron Kumar" -> "@aaron_kumar"
    const username =
      '@' +
      String(name)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, '_')
        .slice(0, 24);

    const result = await pool.query(
      `INSERT INTO reels
        (video_url, thumbnail_url, public_id, duration,
         caption, username, source, contact_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'user', $7, 'live')
       RETURNING id, video_url, thumbnail_url, caption, username, created_at`,
      [
        videoUrl,
        body.thumbnailUrl || null,
        body.publicId || null,
        body.duration || null,
        body.caption ? String(body.caption).trim().slice(0, 300) : null,
        username,
        contactId,
      ]
    );

    return c.json({ success: true, reel: result.rows[0] }, 201);
  } catch (err) {
    console.error('Failed to create reel:', err);
    return c.json({ error: 'Could not post your reel' }, 500);
  }
});

/**
 * POST /reels/:id/view
 * Bumps the view counter. Fire-and-forget from the app.
 */
reelsRoute.post('/:id/view', async (c) => {
  const id = c.req.param('id');

  try {
    await pool.query(
      'UPDATE reels SET view_count = view_count + 1 WHERE id = $1',
      [id]
    );
    return c.json({ success: true });
  } catch {
    // Never worth failing a request over a view count
    return c.json({ success: false });
  }
});
