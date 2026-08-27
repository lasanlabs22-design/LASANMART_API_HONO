import { Hono } from 'hono';
import { pool } from '../db/pool.js';

export const notificationsRoute = new Hono();

function normalisePhone(input: unknown): string {
  const digits = String(input ?? '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/**
 * GET /notifications?phone=9876543210
 * Everything for this person, newest first, plus the unread count.
 */
notificationsRoute.get('/', async (c) => {
  const phone = normalisePhone(c.req.query('phone'));

  if (phone.length !== 10) {
    return c.json({ error: 'A valid 10-digit phone is required' }, 400);
  }

  try {
    const result = await pool.query(
      `SELECT n.id, n.request_id, n.type, n.title, n.body,
              n.read_at, n.created_at
         FROM notifications n
         JOIN contacts c ON c.id = n.contact_id
        WHERE c.phone = $1
        ORDER BY n.created_at DESC
        LIMIT 50`,
      [phone]
    );

    const unread = result.rows.filter((r) => !r.read_at).length;

    return c.json({ notifications: result.rows, unread });
  } catch (err) {
    console.error('Failed to fetch notifications:', err);
    return c.json({ error: 'Could not load notifications' }, 500);
  }
});

/**
 * GET /notifications/count?phone=...
 * Just the badge number — cheap enough to poll.
 */
notificationsRoute.get('/count', async (c) => {
  const phone = normalisePhone(c.req.query('phone'));

  if (phone.length !== 10) {
    return c.json({ unread: 0 });
  }

  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS unread
         FROM notifications n
         JOIN contacts c ON c.id = n.contact_id
        WHERE c.phone = $1 AND n.read_at IS NULL`,
      [phone]
    );

    return c.json({ unread: result.rows[0].unread });
  } catch (err) {
    console.error('Failed to count notifications:', err);
    return c.json({ unread: 0 });
  }
});

/**
 * POST /notifications/read
 * Body: { phone, id? }  — one notification, or all of them
 */
notificationsRoute.post('/read', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }

  const phone = normalisePhone(body.phone);

  if (phone.length !== 10) {
    return c.json({ error: 'A valid 10-digit phone is required' }, 400);
  }

  try {
    if (body.id) {
      await pool.query(
        `UPDATE notifications n
            SET read_at = now()
           FROM contacts c
          WHERE n.contact_id = c.id
            AND c.phone = $1
            AND n.id = $2
            AND n.read_at IS NULL`,
        [phone, body.id]
      );
    } else {
      await pool.query(
        `UPDATE notifications n
            SET read_at = now()
           FROM contacts c
          WHERE n.contact_id = c.id
            AND c.phone = $1
            AND n.read_at IS NULL`,
        [phone]
      );
    }

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to mark as read:', err);
    return c.json({ error: 'Could not update notifications' }, 500);
  }
});