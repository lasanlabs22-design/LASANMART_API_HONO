import { pool } from '../db/pool.js';
import { deleteVideo } from './cloudinary.js';
import { deletablePublicId, fileStillUsed } from './media.js';

/**
 * Removes everything we hold about one contact. Irreversible.
 * Shared by the console's deletion tool and the app's "Delete account",
 * so both always remove the same things.
 *
 * Returns how many video files were freed on Cloudinary.
 */
export async function deleteContactData(contactId: string): Promise<number> {
  const client = await pool.connect();

  let reels: { public_id: string | null; video_url: string | null }[];

  try {
    // Collect the Cloudinary ids before the rows disappear
    reels = (
      await client.query(
        'SELECT public_id, video_url FROM reels WHERE contact_id = $1',
        [contactId]
      )
    ).rows;

    await client.query('BEGIN');

    // Order matters where foreign keys don't cascade
    await client.query('DELETE FROM reel_likes WHERE contact_id = $1', [contactId]);
    await client.query('DELETE FROM notifications WHERE contact_id = $1', [contactId]);
    await client.query('DELETE FROM reels WHERE contact_id = $1', [contactId]);
    await client.query('DELETE FROM requests WHERE contact_id = $1', [contactId]);
    await client.query('DELETE FROM contacts WHERE id = $1', [contactId]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Free the video files. Done after the commit — a stray file is
  // better than a half-finished deletion. Only each reel's own file,
  // and only if nothing else plays it.
  let filesRemoved = 0;
  for (const row of reels) {
    const publicId = deletablePublicId(row);
    if (!publicId || (await fileStillUsed(publicId))) continue;

    if (await deleteVideo(publicId)) filesRemoved += 1;
  }

  return filesRemoved;
}
