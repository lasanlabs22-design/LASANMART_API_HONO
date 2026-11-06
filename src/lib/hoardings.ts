import { pool } from '../db/pool.js';
import { isOwnMedia } from './media.js';

/**
 * Hoardings the team lists from the console, shown in the app under
 * Offline Marketing → Hoardings.
 *
 * Migrations only run by hand, and production's database is only
 * reachable from Railway — so, like reel_reports, the table makes sure
 * of itself the first time it's needed. Mirrors schema.sql.
 */
let ready: Promise<void> | null = null;

export function ensureHoardingsTable(): Promise<void> {
  if (!ready) {
    ready = pool
      .query(
        `CREATE TABLE IF NOT EXISTS hoardings (
           id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
           title TEXT NOT NULL,
           media_type TEXT NOT NULL DEFAULT 'Billboard',
           city TEXT NOT NULL,
           area TEXT NOT NULL,
           address TEXT,
           latitude DOUBLE PRECISION,
           longitude DOUBLE PRECISION,
           width_ft NUMERIC,
           height_ft NUMERIC,
           illumination TEXT,
           facing TEXT,
           traffic TEXT,
           price_per_month INTEGER,
           min_months INTEGER,
           availability TEXT NOT NULL DEFAULT 'available',
           available_from DATE,
           photos JSONB NOT NULL DEFAULT '[]'::jsonb,
           description TEXT,
           status TEXT NOT NULL DEFAULT 'live',
           sort_order INTEGER NOT NULL DEFAULT 0,
           created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
         );
         CREATE INDEX IF NOT EXISTS idx_hoardings_live_city
           ON hoardings(city, area) WHERE status = 'live';`
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

/** Everything the app and console read, in one place */
export const HOARDING_COLUMNS = `id, title, media_type, city, area, address,
  latitude, longitude, width_ft::float AS width_ft, height_ft::float AS height_ft,
  illumination, facing, traffic, price_per_month, min_months,
  availability, to_char(available_from, 'YYYY-MM-DD') AS available_from,
  photos, description, status, sort_order, created_at, updated_at`;

export const AVAILABILITY = ['available', 'booked'] as const;
export const STATUSES = ['live', 'hidden'] as const;

/** Most photos one hoarding can carry */
const MAX_PHOTOS = 8;

/* ---------- Field cleaners ----------
   Each returns the value to store, null to clear it, or undefined when
   the field wasn't sent (so a PATCH leaves it alone). */

function text(raw: unknown, max: number): string | null | undefined {
  if (raw === undefined) return undefined;
  const v = raw === null ? '' : String(raw).trim();
  return v ? v.slice(0, max) : null;
}

function number(
  raw: unknown,
  min: number,
  max: number,
  integer = false
): number | null | undefined | false {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return false;
  return integer ? Math.round(n) : n;
}

type Clean = { values: Record<string, unknown>; error?: string };

/**
 * Checks and tidies what the console sent. With `creating`, the fields
 * a hoarding can't exist without are required; otherwise only the
 * fields present are checked, for a PATCH.
 */
export function cleanHoarding(body: any, creating: boolean): Clean {
  const values: Record<string, unknown> = {};
  const fail = (error: string): Clean => ({ values, error });

  const title = text(body.title, 120);
  const city = text(body.city, 60);
  const area = text(body.area, 80);

  if (creating || title !== undefined) {
    if (!title || title.length < 2) return fail('Give the hoarding a title');
    values.title = title;
  }
  if (creating || city !== undefined) {
    if (!city) return fail('City is required');
    values.city = city;
  }
  if (creating || area !== undefined) {
    if (!area) return fail('Area is required');
    values.area = area;
  }

  const mediaType = text(body.mediaType, 40);
  if (mediaType !== undefined) values.media_type = mediaType || 'Billboard';

  for (const [key, column, max] of [
    ['address', 'address', 200],
    ['illumination', 'illumination', 30],
    ['facing', 'facing', 120],
    ['traffic', 'traffic', 120],
    ['description', 'description', 1000],
  ] as const) {
    const v = text(body[key], max);
    if (v !== undefined) values[column] = v;
  }

  // Coordinates come as a pair or not at all, so a pin is never half set
  const lat = number(body.latitude, -90, 90);
  const lng = number(body.longitude, -180, 180);
  if (lat === false || lng === false) return fail('Location coordinates look wrong');
  if (lat !== undefined || lng !== undefined) {
    if ((lat ?? null) === null || (lng ?? null) === null) {
      values.latitude = null;
      values.longitude = null;
    } else {
      values.latitude = lat;
      values.longitude = lng;
    }
  }

  for (const [key, column, min, max, integer, label] of [
    ['widthFt', 'width_ft', 0.1, 1000, false, 'Width'],
    ['heightFt', 'height_ft', 0.1, 1000, false, 'Height'],
    ['pricePerMonth', 'price_per_month', 0, 100_000_000, true, 'Price'],
    ['minMonths', 'min_months', 1, 60, true, 'Minimum booking'],
    ['sortOrder', 'sort_order', -100000, 100000, true, 'Order'],
  ] as const) {
    const v = number(body[key], min, max, integer);
    if (v === false) return fail(`${label} doesn't look right`);
    if (v !== undefined) values[column] = column === 'sort_order' ? v ?? 0 : v;
  }

  if (body.availability !== undefined) {
    if (!AVAILABILITY.includes(body.availability)) {
      return fail('Availability must be available or booked');
    }
    values.availability = body.availability;
  }

  if (body.availableFrom !== undefined) {
    const v = body.availableFrom ? String(body.availableFrom).trim() : '';
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return fail('Available-from date looks wrong');
    values.available_from = v || null;
  }

  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return fail('Status must be live or hidden');
    values.status = body.status;
  }

  if (body.photos !== undefined) {
    if (!Array.isArray(body.photos)) return fail('Photos must be a list');
    // Only images in our own Cloudinary account — the app shows these
    const photos = body.photos
      .filter((p: unknown) => isOwnMedia(p, 'image'))
      .slice(0, MAX_PHOTOS);
    values.photos = JSON.stringify(photos);
  }

  return { values };
}
