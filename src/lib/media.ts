import { config } from '../config.js';
import { pool } from '../db/pool.js';

/**
 * Media URLs the app sends us must live in OUR Cloudinary account.
 * Anything else could point the feed — or a delete — at files we
 * don't control.
 */

type Kind = 'video' | 'image';

function base(kind: Kind) {
  return `https://res.cloudinary.com/${config.cloudinary.cloudName}/${kind}/upload/`;
}

/** True when the URL is a file in our own Cloudinary account */
export function isOwnMedia(url: unknown, kind: Kind): url is string {
  return typeof url === 'string' && url.startsWith(base(kind));
}

/**
 * Cloudinary's public id, read from a delivery URL:
 *   .../video/upload/v1726/lasan_reels/abc.mp4  ->  lasan_reels/abc
 *
 * Worked out here rather than trusted from the app, since the id is
 * what our signed delete call acts on.
 */
export function publicIdFromUrl(url: string, kind: Kind): string | null {
  if (!isOwnMedia(url, kind)) return null;

  const segments = url.slice(base(kind).length).split('?')[0].split('/');

  // Everything after the version marker is the id; without one,
  // the whole path is
  const v = segments.findIndex((s) => /^v\d+$/.test(s));
  const path = (v === -1 ? segments : segments.slice(v + 1)).join('/');

  const id = decodeURIComponent(path.replace(/\.[a-z0-9]+$/i, ''));
  return id || null;
}

/**
 * The public id we may safely delete for a stored reel — only when it
 * matches the reel's own video URL. Rows saved before this check
 * existed could carry someone else's id.
 */
export function deletablePublicId(row: {
  public_id: string | null;
  video_url: string | null;
}): string | null {
  if (!row.public_id || !row.video_url) return null;
  return publicIdFromUrl(row.video_url, 'video') === row.public_id
    ? row.public_id
    : null;
}

/** True when some remaining reel still points at this file */
export async function fileStillUsed(publicId: string): Promise<boolean> {
  const result = await pool.query(
    'SELECT 1 FROM reels WHERE public_id = $1 LIMIT 1',
    [publicId]
  );
  return result.rows.length > 0;
}

/** Profile photos and logos: our Cloudinary, or a Google account photo */
export function isAllowedPhotoUrl(url: unknown): url is string {
  return (
    isOwnMedia(url, 'image') ||
    (typeof url === 'string' &&
      /^https:\/\/lh\d\.googleusercontent\.com\//.test(url))
  );
}
