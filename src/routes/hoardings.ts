import { Hono } from 'hono';
import { pool } from '../db/pool.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { signedUpload } from '../lib/uploadSignature.js';
import {
  ensureHoardingsTable,
  HOARDING_COLUMNS,
  cleanHoarding,
} from '../lib/hoardings.js';

/* ================= Customer-facing ================= */

export const hoardingsRoute = new Hono();

/**
 * GET /hoardings
 * Every live hoarding, plus the cities and areas they're in so the app
 * can offer them as filters. Public — someone browsing may not have
 * signed in yet. The app filters and sorts by distance itself; the
 * list is the team's own inventory, so it stays small.
 */
hoardingsRoute.get('/', async (c) => {
  try {
    await ensureHoardingsTable();

    const result = await pool.query(
      `SELECT ${HOARDING_COLUMNS}
         FROM hoardings
        WHERE status = 'live'
        ORDER BY city, area, sort_order DESC, created_at DESC
        LIMIT 500`
    );

    // { city, areas[] }, both alphabetical
    const byCity = new Map<string, Set<string>>();
    for (const h of result.rows) {
      if (!byCity.has(h.city)) byCity.set(h.city, new Set());
      byCity.get(h.city)!.add(h.area);
    }
    const cities = [...byCity.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([city, areas]) => ({
        city,
        areas: [...areas].sort((a, b) => a.localeCompare(b)),
      }));

    return c.json({ hoardings: result.rows, cities });
  } catch (err) {
    console.error('Failed to load hoardings:', err);
    return c.json({ error: 'Could not load hoardings' }, 500);
  }
});

/* ================= Team-facing (admin console) ================= */

export const adminHoardingsRoute = new Hono();

// Everything below needs the admin key
adminHoardingsRoute.use('*', adminAuth);

/**
 * GET /admin/hoardings
 * All of them, hidden ones included, with counts for the page header.
 */
adminHoardingsRoute.get('/', async (c) => {
  try {
    await ensureHoardingsTable();

    const [list, counts] = await Promise.all([
      pool.query(
        `SELECT ${HOARDING_COLUMNS}
           FROM hoardings
          ORDER BY city, area, sort_order DESC, created_at DESC
          LIMIT 1000`
      ),
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'live')::int AS live,
          COUNT(*) FILTER (WHERE status = 'live' AND availability = 'available')::int AS available,
          COUNT(DISTINCT city)::int AS cities
        FROM hoardings
      `),
    ]);

    return c.json({ hoardings: list.rows, stats: counts.rows[0] });
  } catch (err) {
    console.error('Failed to load hoardings:', err);
    return c.json({ error: 'Could not load hoardings' }, 500);
  }
});

/**
 * POST /admin/hoardings/upload-signature
 * Signs one photo upload into the hoardings folder. The secret stays
 * here; the console uploads straight to Cloudinary with this.
 */
adminHoardingsRoute.post('/upload-signature', (c) =>
  c.json(signedUpload('hoardings'))
);

/**
 * POST /admin/hoardings
 * The team adding a hoarding.
 */
adminHoardingsRoute.post('/', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }

  const { values, error } = cleanHoarding(body, true);
  if (error) return c.json({ error }, 400);

  const columns = Object.keys(values);
  const params = Object.values(values);

  try {
    await ensureHoardingsTable();

    const result = await pool.query(
      `INSERT INTO hoardings (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
       RETURNING ${HOARDING_COLUMNS}`,
      params
    );

    return c.json({ success: true, hoarding: result.rows[0] }, 201);
  } catch (err) {
    console.error('Failed to create hoarding:', err);
    return c.json({ error: 'Could not save the hoarding' }, 500);
  }
});

/**
 * PATCH /admin/hoardings/:id
 * Edit any field — including marking it booked, or hiding it.
 */
adminHoardingsRoute.patch('/:id', async (c) => {
  const id = c.req.param('id');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }

  const { values, error } = cleanHoarding(body, false);
  if (error) return c.json({ error }, 400);

  const columns = Object.keys(values);
  if (columns.length === 0) {
    return c.json({ error: 'Nothing to update' }, 400);
  }

  const params = [...Object.values(values), id];

  try {
    await ensureHoardingsTable();

    const result = await pool.query(
      `UPDATE hoardings
          SET ${columns.map((col, i) => `${col} = $${i + 1}`).join(', ')},
              updated_at = now()
        WHERE id = $${params.length}
        RETURNING ${HOARDING_COLUMNS}`,
      params
    );

    if (result.rows.length === 0) {
      return c.json({ error: 'Hoarding not found' }, 404);
    }

    return c.json({ success: true, hoarding: result.rows[0] });
  } catch (err) {
    console.error('Failed to update hoarding:', err);
    return c.json({ error: 'Could not update the hoarding' }, 500);
  }
});

/**
 * DELETE /admin/hoardings/:id
 * Removes the listing. Its photos stay in Cloudinary — a stray image
 * costs nothing, and requests that mention it keep their context.
 */
adminHoardingsRoute.delete('/:id', async (c) => {
  const id = c.req.param('id');

  try {
    await ensureHoardingsTable();

    const result = await pool.query(
      'DELETE FROM hoardings WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rows.length === 0) {
      return c.json({ error: 'Hoarding not found' }, 404);
    }

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to delete hoarding:', err);
    return c.json({ error: 'Could not delete the hoarding' }, 500);
  }
});
