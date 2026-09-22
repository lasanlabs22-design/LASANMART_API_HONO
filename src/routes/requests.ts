import { Hono } from 'hono';
import { pool } from '../db/pool.js';
import { sendRequestNotification } from '../email/notify.js';
import { notifyFirstRequest } from '../lib/notifications.js';
import { requirePhone } from '../middleware/requirePhone.js';
import { isAllowedPhotoUrl } from '../lib/media.js';
import { rateLimit, HOUR } from '../lib/rateLimit.js';

export const requestsRoute = new Hono<{ Variables: { phone: string } }>();

const VALID_TYPES = ['service', 'custom', 'plan', 'influencer'];

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * POST /requests
 * Requires a verified phone (via requirePhone) — the number comes from
 * the Firebase token, never from the request body, so nobody can post
 * a request under someone else's number.
 *
 * Body shape:
 * {
 *   type: "service" | "custom" | "plan" | "influencer",
 *   name: string,
 *   email?: string,
 *   companyName?: string,
 *   companyDescription?: string,
 *   sector?: string,
 *   city?: string,
 *   title?: string,
 *   description?: string,
 *   descriptionLabel?: string,   // heading shown above the description
 *   details?: object             // type-specific extra data
 * }
 */
requestsRoute.post('/', requirePhone, rateLimit('request', 20, HOUR), async (c) => {
  // The number is verified, so we ignore whatever the body claims
  const phone = c.get('phone');

  let body: any;

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Request body must be valid JSON' }, 400);
  }

  const { type } = body;

  /* ---------- Validation ---------- */

  if (!type || !body.name) {
    return c.json({ error: 'Missing required fields: type, name' }, 400);
  }

  if (!VALID_TYPES.includes(type)) {
    return c.json({ error: 'Invalid type' }, 400);
  }

  const name = String(body.name).trim();
  if (name.length < 2) {
    return c.json({ error: 'Name is too short' }, 400);
  }

  const email = body.email ? String(body.email).trim().toLowerCase() : null;
  if (email && !isValidEmail(email)) {
    return c.json({ error: 'Email is not valid' }, 400);
  }

  /* ---------- Save ---------- */

  const client = await pool.connect();
  let committed = false;

  try {
    await client.query('BEGIN');

    // Step 1: find or create the contact (person), matched by phone
    const existingContact = await client.query(
      'SELECT id FROM contacts WHERE phone = $1',
      [phone]
    );

    let contactId: string;
    let isNewContact = false;

    if (existingContact.rows.length > 0) {
      contactId = existingContact.rows[0].id;

      // COALESCE keeps existing values when this submission omits them —
      // a partial form must never wipe details we already have
      await client.query(
        `UPDATE contacts SET
          name = COALESCE($1, name),
          email = COALESCE($2, email),
          company_name = COALESCE($3, company_name),
          company_description = COALESCE($4, company_description),
          sector = COALESCE($5, sector),
          city = COALESCE($6, city),
          updated_at = now()
         WHERE id = $7`,
        [
          name,
          email,
          body.companyName || null,
          body.companyDescription || null,
          body.sector || null,
          body.city || null,
          contactId,
        ]
      );
    } else {
      isNewContact = true;

      const newContact = await client.query(
        `INSERT INTO contacts
          (name, phone, email, company_name, company_description, sector, city)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          name,
          phone,
          email,
          body.companyName || null,
          body.companyDescription || null,
          body.sector || null,
          body.city || null,
        ]
      );
      contactId = newContact.rows[0].id;
    }

    // Step 1.5: for influencer requests only, don't create a duplicate
    // if the same creator is already in an open request from this
    // contact. "Open" = not closed and not rejected — a resolved
    // request doesn't block asking again later.
    if (type === 'influencer' && Array.isArray(body.details?.creators)) {
      const creatorNames: string[] = body.details.creators
        .map((c: any) => String(c).split(' (')[0].trim()) // strip "(@handle)"
        .filter(Boolean);

      if (creatorNames.length > 0) {
        const dup = await client.query(
          `SELECT id, status, created_at, details
             FROM requests
            WHERE contact_id = $1
              AND type = 'influencer'
              AND status NOT IN ('closed', 'rejected')
            ORDER BY created_at DESC`,
          [contactId]
        );

        const existing = dup.rows.find((row) => {
          const existingCreators: string[] = Array.isArray(row.details?.creators)
            ? row.details.creators.map((c: any) => String(c).split(' (')[0].trim())
            : [];
          return creatorNames.some((n) => existingCreators.includes(n));
        });

        if (existing) {
          await client.query('ROLLBACK');
          committed = true; // prevents the catch block rolling back twice

          const existingCreators: string[] = Array.isArray(existing.details?.creators)
            ? existing.details.creators.map((c: any) => String(c).split(' (')[0].trim())
            : [];
          const matchedName = creatorNames.find((n) => existingCreators.includes(n));

          return c.json(
            {
              error: 'already_requested',
              message: matchedName
                ? `You already have an open request that includes ${matchedName}.`
                : 'You already have an open request for this creator.',
              existingRequestId: existing.id,
              existingStatus: existing.status,
              matchedCreator: matchedName || null,
            },
            409
          );
        }
      }
    }

    // Step 2: create the request itself, linked to that contact
    const newRequest = await client.query(
      `INSERT INTO requests
        (contact_id, type, title, description, details, status, email_sent)
       VALUES ($1, $2, $3, $4, $5, 'new', false)
       RETURNING id, created_at`,
      [
        contactId,
        type,
        body.title || null,
        body.description || null,
        body.details ? JSON.stringify(body.details) : null,
      ]
    );

    await client.query('COMMIT');
    committed = true;

    const requestId = newRequest.rows[0].id;

    /* ---------- Notify ---------- */

    // First time we've seen this person? Welcome them in the app,
    // so the notifications screen isn't empty when they open it
    if (isNewContact) {
      await notifyFirstRequest(contactId, requestId);
    }

    // Sent AFTER commit — if email fails, the lead is already safe
    let emailSent = false;
    try {
      await sendRequestNotification({
        requestId,
        type,
        name,
        phone,
        email,
        companyName: body.companyName,
        sector: body.sector,
        city: body.city,
        title: body.title,
        description: body.description,
        descriptionLabel: body.descriptionLabel,
        details: body.details,
      });
      emailSent = true;

      await pool.query('UPDATE requests SET email_sent = true WHERE id = $1', [
        requestId,
      ]);
    } catch (emailErr) {
      console.error(
        'Email notification failed (request still saved):',
        emailErr
      );
      // Deliberately not failing the request — the lead is in the database
    }

    return c.json(
      {
        success: true,
        requestId,
        contactId,
        emailSent,
        createdAt: newRequest.rows[0].created_at,
      },
      201
    );
  } catch (err) {
    // Only roll back if the transaction is still open
    if (!committed) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('Failed to create request:', err);
    return c.json({ error: 'Something went wrong. Please try again.' }, 500);
  } finally {
    client.release();
  }
});

/**
 * GET /requests/contact
 * The contact record behind the verified number — so someone signing in
 * on a new phone gets their name and email back, not an empty profile.
 *
 * Declared before GET / purely for readability; the paths don't collide.
 */
requestsRoute.get('/contact', requirePhone, async (c) => {
  const phone = c.get('phone');

  try {
    const result = await pool.query(
      `SELECT name, email, company_name, company_description, sector, city,
              photo_url, logo_url
         FROM contacts WHERE phone = $1`,
      [phone]
    );

    const row = result.rows[0];

    return c.json({
      contact: row
        ? {
            name: row.name,
            email: row.email,
            phone,
            companyName: row.company_name,
            companyDescription: row.company_description,
            sector: row.sector,
            city: row.city,
            photoUrl: row.photo_url,
            logoUrl: row.logo_url,
          }
        : null,
    });
  } catch (err) {
    console.error('Failed to load contact:', err);
    return c.json({ error: 'Could not load your details' }, 500);
  }
});

/**
 * POST /requests/contact
 * Saves profile details that aren't tied to a request — photos, mainly.
 */
requestsRoute.post('/contact', requirePhone, rateLimit('contact', 30, HOUR), async (c) => {
  const phone = c.get('phone');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }

  try {
    await pool.query(
      `UPDATE contacts SET
         photo_url = COALESCE($1, photo_url),
         logo_url = COALESCE($2, logo_url),
         updated_at = now()
       WHERE phone = $3`,
      // Anything that isn't our Cloudinary (or a Google account photo)
      // is dropped — the console shows these, so they must be ours
      [
        isAllowedPhotoUrl(body.photoUrl) ? body.photoUrl : null,
        isAllowedPhotoUrl(body.logoUrl) ? body.logoUrl : null,
        phone,
      ]
    );

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to save contact details:', err);
    return c.json({ error: 'Could not save' }, 500);
  }
});

/**
 * GET /requests/:id/progress
 * What the customer is allowed to see about who's doing their work.
 *
 * No company name, no phone, no GST — just that a partner has it and
 * where it's got to.
 */
requestsRoute.get('/:id/progress', requirePhone, async (c) => {
  const id = c.req.param('id');
  const phone = c.get('phone');

  try {
    const result = await pool.query(
      `SELECT a.status, a.assigned_at, a.completed_at
         FROM request_assignments a
         JOIN requests r ON r.id = a.request_id
         JOIN contacts c ON c.id = r.contact_id
        WHERE a.request_id = $1
          AND c.phone = $2
          AND a.status IN ('accepted','in_progress','completed')
        ORDER BY a.assigned_at DESC
        LIMIT 1`,
      [id, phone]
    );

    return c.json({ progress: result.rows[0] || null });
  } catch (err) {
    console.error('Failed to load progress:', err);
    return c.json({ error: 'Could not load progress' }, 500);
  }
});

/**
 * POST /requests/:id/feedback
 * Body: { verdict: 'good' | 'okay' | 'poor', comment? }
 *
 * Deliberately three answers rather than five stars — everyone gives
 * five, and a compressed scale tells us nothing. Kept internal.
 */
requestsRoute.post('/:id/feedback', requirePhone, rateLimit('feedback', 30, HOUR), async (c) => {
  const id = c.req.param('id');
  const phone = c.get('phone');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }

  if (!['good', 'okay', 'poor'].includes(body.verdict)) {
    return c.json({ error: 'Invalid verdict' }, 400);
  }

  try {
    // Find the completed assignment, and check it's theirs to rate
    const assignment = await pool.query(
      `SELECT a.id, a.partner_id
         FROM request_assignments a
         JOIN requests r ON r.id = a.request_id
         JOIN contacts c ON c.id = r.contact_id
        WHERE a.request_id = $1 AND c.phone = $2 AND a.status = 'completed'
        LIMIT 1`,
      [id, phone]
    );

    if (assignment.rows.length === 0) {
      return c.json({ error: 'Nothing to give feedback on yet' }, 404);
    }

    await pool.query(
      `INSERT INTO assignment_feedback (assignment_id, partner_id, verdict, comment)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (assignment_id) DO UPDATE SET
         verdict = EXCLUDED.verdict,
         comment = EXCLUDED.comment`,
      [
        assignment.rows[0].id,
        assignment.rows[0].partner_id,
        body.verdict,
        body.comment ? String(body.comment).trim().slice(0, 500) : null,
      ]
    );

    // A happy client is a stronger signal than a manual click, so
    // close it ourselves. Okay and poor stay open for the team.
    if (body.verdict === 'good') {
      await pool
        .query(
          `UPDATE requests SET status = 'closed', updated_at = now()
            WHERE id = $1 AND status != 'closed'`,
          [id]
        )
        .catch(() => {});
    }

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to save feedback:', err);
    return c.json({ error: 'Could not save your feedback' }, 500);
  }
});

/**
 * GET /requests
 * Everything this person has submitted, newest first.
 *
 * The phone number comes from the verified Firebase token, never
 * from a query parameter — otherwise anyone could read anyone's
 * requests by guessing a number.
 */
requestsRoute.get('/', requirePhone, async (c) => {
  const phone = c.get('phone');

  try {
    const result = await pool.query(
      `SELECT r.id, r.type, r.title, r.description, r.details,
              r.status, r.created_at
         FROM requests r
         JOIN contacts c ON c.id = r.contact_id
        WHERE c.phone = $1
        ORDER BY r.created_at DESC
        LIMIT 100`,
      [phone]
    );

    return c.json({ requests: result.rows });
  } catch (err) {
    console.error('Failed to fetch requests:', err);
    return c.json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});
