import { pool } from '../db/pool.js';
import { sendPush } from './push.js';

/**
 * Migrations only run by hand, and production's database is only
 * reachable from Railway — so the partner push column makes sure of
 * itself the first time it's needed. Mirrors schema.sql.
 */
let ready: Promise<void> | null = null;

export function ensurePartnerPushColumn(): Promise<void> {
  if (!ready) {
    ready = pool
      .query(
        `ALTER TABLE influencers ADD COLUMN IF NOT EXISTS push_token TEXT;
         ALTER TABLE influencers ADD COLUMN IF NOT EXISTS push_updated_at TIMESTAMPTZ;`
      )
      .then(() => undefined)
      .catch((err) => {
        // Let the next call try again rather than caching the failure
        ready = null;
        throw err;
      });
  }

  return ready;
}

/**
 * Tells a Lasan Hub partner something happened — in the app's list,
 * and on their phone if they've allowed notifications.
 *
 * Never throws — a failed notification must not break the action that
 * triggered it. Customer feedback is deliberately not sent this way:
 * criticism with no context and no right of reply is worse than a
 * phone call from our team.
 */
export async function notifyPartner(
  partnerId: string,
  payload: {
    assignmentId?: string;
    type?: 'work' | 'profile';
    title: string;
    body: string;
  }
) {
  const type = payload.type || 'work';

  try {
    await pool.query(
      `INSERT INTO partner_notifications
        (partner_id, assignment_id, type, title, body)
       VALUES ($1, $2, $3, $4, $5)`,
      [partnerId, payload.assignmentId || null, type, payload.title, payload.body]
    );
  } catch (err) {
    console.error('Failed to notify partner:', err);
  }

  // The list entry is saved either way, so a failed push just means
  // they see it next time they open Lasan Hub
  try {
    await ensurePartnerPushColumn();

    const result = await pool.query(
      'SELECT push_token FROM influencers WHERE id = $1',
      [partnerId]
    );
    const token = result.rows[0]?.push_token;

    if (token) {
      await sendPush({
        to: token,
        title: payload.title,
        body: payload.body,
        data: { type, assignmentId: payload.assignmentId || null },
      });
    }
  } catch (err) {
    console.error('Failed to push to partner:', err);
  }
}
