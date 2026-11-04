import { pool } from '../db/pool.js';

/**
 * Columns added to requests after launch. Migrations only run by hand,
 * and production's database is only reachable from Railway — so, like
 * reel_reports, they make sure of themselves the first time they're
 * needed. Mirrors schema.sql.
 *
 * description_label: the question the description answers (Tool
 * Enquiry asks "How do you track attendance today?"), so the admin
 * console can show it above the answer like the email does.
 */
let ready: Promise<void> | null = null;

export function ensureRequestColumns(): Promise<void> {
  if (!ready) {
    ready = pool
      .query(
        `ALTER TABLE requests
           ADD COLUMN IF NOT EXISTS description_label TEXT;`
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
