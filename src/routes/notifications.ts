import { Hono } from 'hono';
import { pool } from '../db/pool.js';
import { requirePhone } from '../middleware/requirePhone.js';

export const notificationsRoute = new Hono<{ Variables: { phone: string } }>();

/**
 * GET /notifications
 * Everything for this person, newest first, plus the unread count.
 *
 * Phone comes from the verified Firebase token — never a query
 * parameter, or anyone could read anyone's notifications by guessing
 * a number.
 */
notificationsRoute.get('/', requirePhone, async (c) => {
  const phone = c.get('phone');

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
 * GET /notifications/count
 * Just the badge number — cheap enough to poll.
 */
notificationsRoute.get('/count', requirePhone, async (c) => {
  const phone = c.get('phone');

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
 * Body: { id? }  — one notification, or all of them.
 * Phone comes from the verified token, so this can only ever
 * touch the calling person's own notifications.
 */
notificationsRoute.post('/read', requirePhone, async (c) => {
  const phone = c.get('phone');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
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

/**
 * POST /notifications/token
 * The app registers its device here so we can push to it.
 * Body: { token }
 *
 * Phone comes from the verified token — a push token must only ever
 * be registered against the number that's actually signed in, or
 * anyone could redirect someone else's notifications to their own phone.
 */
notificationsRoute.post('/token', requirePhone, async (c) => {
  const phone = c.get('phone');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }

  const token = String(body.token || '').trim();

  if (!token.startsWith('ExponentPushToken')) {
    return c.json({ error: 'Invalid push token' }, 400);
  }

  try {
    // Clear this token from anyone else first — phones get handed on,
    // and two contacts sharing a token means notifications go astray
    await pool.query(
      'UPDATE contacts SET push_token = NULL WHERE push_token = $1',
      [token]
    );

    const result = await pool.query(
      `UPDATE contacts
          SET push_token = $1, push_updated_at = now()
        WHERE phone = $2
        RETURNING id`,
      [token, phone]
    );

    if (result.rows.length === 0) {
      // No contact yet — they haven't submitted anything.
      // Not an error; the app will try again after their first request.
      return c.json({ success: false, reason: 'no_contact' });
    }

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to save push token:', err);
    return c.json({ error: 'Could not register for notifications' }, 500);
  }
});
