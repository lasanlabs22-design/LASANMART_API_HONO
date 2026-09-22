import { Hono } from 'hono';
import { getAuth } from 'firebase-admin/auth';
import { pool } from '../db/pool.js';
import { requirePhone } from '../middleware/requirePhone.js';
import { rateLimit, HOUR } from '../lib/rateLimit.js';
import { deleteContactData } from '../lib/contactDeletion.js';

export const accountRoute = new Hono<{ Variables: { phone: string } }>();

/**
 * DELETE /account
 * The app's "Delete account" — required by both app stores.
 *
 * Removes everything we hold against the verified number, then the
 * Firebase sign-in itself, so the number starts completely fresh.
 * A Lasan Hub partner profile on the same number is a separate
 * product and is left alone.
 */
accountRoute.delete('/', requirePhone, rateLimit('account-delete', 5, HOUR), async (c) => {
  const phone = c.get('phone');

  try {
    const contact = await pool.query('SELECT id FROM contacts WHERE phone = $1', [
      phone,
    ]);

    let filesRemoved = 0;
    if (contact.rows[0]) {
      filesRemoved = await deleteContactData(contact.rows[0].id);
    }

    // The data is gone either way; a failure here only means the
    // sign-in lingers until it expires, so it is logged, not surfaced
    try {
      const user = await getAuth().getUserByPhoneNumber(`+91${phone}`);
      await getAuth().deleteUser(user.uid);
    } catch (err: any) {
      if (err?.code !== 'auth/user-not-found') {
        console.error('Could not delete Firebase user:', err?.code || err);
      }
    }

    console.log(`Account deleted by its owner (${phone}); ${filesRemoved} video(s) removed`);
    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to delete account:', err);
    return c.json({ error: 'Could not delete your account. Please try again.' }, 500);
  }
});
