import crypto from 'crypto';
import { Hono } from 'hono';
import { pool } from '../db/pool.js';
import { requirePhone } from '../middleware/requirePhone.js';
import { rateLimit, HOUR } from '../lib/rateLimit.js';
import { signedUpload } from '../lib/uploadSignature.js';

export const uploadsRoute = new Hono<{ Variables: { phone: string } }>();

/**
 * POST /uploads/signature
 * Body: { kind: 'reel' | 'photo' }
 *
 * Reels need Vibes access — the same check as posting, so being turned
 * down now also means not being able to fill our storage. Each person's
 * files go into their own folder, which is how we know a file is theirs.
 */
uploadsRoute.post(
  '/signature',
  requirePhone,
  rateLimit('upload-signature', 60, HOUR),
  async (c) => {
    const phone = c.get('phone');

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Body must be valid JSON' }, 400);
    }

    let folder: string;

    if (body.kind === 'reel') {
      const result = await pool.query(
        'SELECT id, can_post_vibes FROM contacts WHERE phone = $1',
        [phone]
      );
      const row = result.rows[0];

      if (!row?.can_post_vibes) {
        return c.json({ error: 'You do not have posting access yet' }, 403);
      }

      folder = `reels/${row.id}`;
    } else if (body.kind === 'photo') {
      // May come before we have a contact row, so the folder is keyed
      // on the number instead — hashed, so it isn't readable in URLs
      const key = crypto
        .createHash('sha256')
        .update(phone)
        .digest('hex')
        .slice(0, 16);
      folder = `profiles/${key}`;
    } else {
      return c.json({ error: 'Unknown upload kind' }, 400);
    }

    return c.json(signedUpload(folder));
  }
);
