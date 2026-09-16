import { pool } from '../db/pool.js';

/**
 * Tells a Lasan Hub partner something happened.
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
  try {
    await pool.query(
      `INSERT INTO partner_notifications
        (partner_id, assignment_id, type, title, body)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        partnerId,
        payload.assignmentId || null,
        payload.type || 'work',
        payload.title,
        payload.body,
      ]
    );
  } catch (err) {
    console.error('Failed to notify partner:', err);
  }
}