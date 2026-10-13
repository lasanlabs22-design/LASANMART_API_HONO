import { pool } from '../db/pool.js';

/** The reasons the app offers. Anything else is stored as 'other'. */
export const REPORT_REASONS = [
  'spam',
  'inappropriate',
  'misleading',
  'harassment',
  'other',
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

/** Distinct reporters before a user's reel comes down for review */
export const AUTO_HIDE_AFTER = 3;

/**
 * Migrations only run by hand, and production's database is only
 * reachable from Railway — so the table makes sure of itself the first
 * time it's needed. Mirrors the definition in schema.sql.
 */
let ready: Promise<void> | null = null;

export function ensureReportsTable(): Promise<void> {
  if (!ready) {
    ready = pool
      .query(
        `CREATE TABLE IF NOT EXISTS reel_reports (
           id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
           reel_id TEXT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
           reporter TEXT NOT NULL,
           reason TEXT NOT NULL,
           details TEXT,
           created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
           UNIQUE (reel_id, reporter)
         );
         CREATE INDEX IF NOT EXISTS idx_reel_reports_reel
           ON reel_reports(reel_id);`
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
