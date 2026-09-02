import { Hono } from 'hono';
import { pool } from '../db/pool.js';
import { requirePhone } from '../middleware/requirePhone.js';
import { verifiedPhoneFrom } from '../lib/firebase.js';
import { deleteVideo } from '../lib/cloudinary.js';

export const reelsRoute = new Hono<{ Variables: { phone: string } }>();

/**
 * GET /reels
 * The feed. Public, but if a valid token is present we also mark
 * which reels this person has already liked.
 */
reelsRoute.get('/', async (c) => {
  const limit = Math.min(50, Number(c.req.query('limit')) || 30);

  // Optional — the feed works signed out, we just can't show
  // their own likes in that case
  const phone = await verifiedPhoneFrom(c.req.header('Authorization'));

  try {
    const result = await pool.query(
      `SELECT r.id, r.video_url, r.thumbnail_url, r.caption, r.username,
              r.source, r.duration, r.view_count, r.like_count, r.created_at,
              r.contact_id,
              CASE WHEN $2::text IS NULL THEN false
                   ELSE EXISTS (
                     SELECT 1 FROM reel_likes l
                       JOIN contacts c ON c.id = l.contact_id
                      WHERE l.reel_id = r.id AND c.phone = $2
                   )
              END AS liked_by_me,
              CASE WHEN $2::text IS NULL THEN false
                   ELSE EXISTS (
                     SELECT 1 FROM contacts c
                      WHERE c.id = r.contact_id AND c.phone = $2
                   )
              END AS is_mine
         FROM reels r
        WHERE r.status = 'live'
        ORDER BY r.sort_order DESC, r.created_at DESC
        LIMIT $1`,
      [limit, phone]
    );

    return c.json({ reels: result.rows });
  } catch (err) {
    console.error('Failed to load reels:', err);
    return c.json({ error: 'Could not load reels' }, 500);
  }
});

/**
 * GET /reels/mine
 * Everything this person has posted, including anything the team
 * has hidden — so they can see it's still there.
 *
 * The phone comes from the verified token, never a query parameter.
 */
reelsRoute.get('/mine', requirePhone, async (c) => {
  const phone = c.get('phone');

  try {
    const result = await pool.query(
      `SELECT r.id, r.video_url, r.thumbnail_url, r.caption, r.username,
              r.source, r.status, r.duration, r.view_count, r.like_count, r.created_at
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
 * Body: { videoUrl, thumbnailUrl?, publicId?, duration?, caption? }
 * The poster's identity comes from the token, so nobody can post
 * a reel under someone else's name.
 */
reelsRoute.post('/', requirePhone, async (c) => {
  const phone = c.get('phone');

  let body: any;

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }

  const videoUrl = String(body.videoUrl || '').trim();

  if (!videoUrl.startsWith('http')) {
    return c.json({ error: 'A valid video URL is required' }, 400);
  }

  try {
    // We only accept reels from people we already know
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
 * Bumps the view counter. Fire-and-forget from the app, and
 * deliberately open — counting views needs no identity.
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

/**
 * POST /reels/:id/like
 * Toggles a like. Returns the new state and count.
 */
reelsRoute.post('/:id/like', requirePhone, async (c) => {
  const reelId = c.req.param('id');
  const phone = c.get('phone');

  const client = await pool.connect();

  try {
    const contact = await client.query(
      'SELECT id FROM contacts WHERE phone = $1',
      [phone]
    );

    if (contact.rows.length === 0) {
      return c.json({ error: 'Complete your profile first' }, 403);
    }

    const contactId = contact.rows[0].id;

    await client.query('BEGIN');

    // Already liked? Remove it. Otherwise add it.
    const existing = await client.query(
      'SELECT 1 FROM reel_likes WHERE reel_id = $1 AND contact_id = $2',
      [reelId, contactId]
    );

    let liked: boolean;

    if (existing.rows.length > 0) {
      await client.query(
        'DELETE FROM reel_likes WHERE reel_id = $1 AND contact_id = $2',
        [reelId, contactId]
      );
      await client.query(
        'UPDATE reels SET like_count = GREATEST(0, like_count - 1) WHERE id = $1',
        [reelId]
      );
      liked = false;
    } else {
      await client.query(
        'INSERT INTO reel_likes (reel_id, contact_id) VALUES ($1, $2)',
        [reelId, contactId]
      );
      await client.query(
        'UPDATE reels SET like_count = like_count + 1 WHERE id = $1',
        [reelId]
      );
      liked = true;
    }

    const updated = await client.query(
      'SELECT like_count FROM reels WHERE id = $1',
      [reelId]
    );

    await client.query('COMMIT');

    return c.json({
      liked,
      likeCount: updated.rows[0]?.like_count ?? 0,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Failed to toggle like:', err);
    return c.json({ error: 'Could not update like' }, 500);
  } finally {
    client.release();
  }
});

/**
 * PATCH /reels/:id
 * Edit your own caption. Ownership is checked against the token.
 */
reelsRoute.patch('/:id', requirePhone, async (c) => {
  const reelId = c.req.param('id');
  const phone = c.get('phone');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }

  const caption = body.caption
    ? String(body.caption).trim().slice(0, 300)
    : null;

  try {
    const result = await pool.query(
      `UPDATE reels r
          SET caption = $1, updated_at = now()
         FROM contacts c
        WHERE r.id = $2
          AND r.contact_id = c.id
          AND c.phone = $3
        RETURNING r.id, r.caption`,
      [caption, reelId, phone]
    );

    // No rows means it isn't theirs — same response as not found,
    // so nobody can probe for other people's reel ids
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
 * DELETE /reels/:id
 * Delete your own reel, and its file on Cloudinary.
 */
reelsRoute.delete('/:id', requirePhone, async (c) => {
  const reelId = c.req.param('id');
  const phone = c.get('phone');

  try {
    // Fetch and check ownership in one query
    const existing = await pool.query(
      `SELECT r.public_id
         FROM reels r
         JOIN contacts c ON c.id = r.contact_id
        WHERE r.id = $1 AND c.phone = $2`,
      [reelId, phone]
    );

    if (existing.rows.length === 0) {
      return c.json({ error: 'Reel not found' }, 404);
    }

    const publicId = existing.rows[0].public_id;

    await pool.query('DELETE FROM reels WHERE id = $1', [reelId]);

    // Free the storage. A stray file is better than a reel
    // that refuses to disappear from the app.
    if (publicId) {
      await deleteVideo(publicId);
    }

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to delete reel:', err);
    return c.json({ error: 'Could not delete the reel' }, 500);
  }
});
