import { Hono } from 'hono';
import { pool } from '../db/pool.js';
import { sendRequestNotification } from '../email/notify.js';
import { notifyFirstRequest } from '../lib/notifications.js';
import { requirePhone } from '../middleware/requirePhone.js';

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
requestsRoute.post('/', requirePhone, async (c) => {
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
