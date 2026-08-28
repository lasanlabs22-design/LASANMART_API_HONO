import crypto from 'crypto';
import { config } from '../config.js';

/**
 * Deletes a video from Cloudinary.
 *
 * Cloudinary's delete API needs a signature: a SHA-1 hash of the
 * parameters plus your API secret. That's why this runs on the server
 * and never in a browser.
 */
export async function deleteVideo(publicId: string): Promise<boolean> {
  if (!publicId) return false;

  const timestamp = Math.round(Date.now() / 1000);

  const signature = crypto
    .createHash('sha1')
    .update(
      `public_id=${publicId}&timestamp=${timestamp}${config.cloudinary.apiSecret}`
    )
    .digest('hex');

  const form = new URLSearchParams({
    public_id: publicId,
    timestamp: String(timestamp),
    api_key: config.cloudinary.apiKey,
    signature,
  });

  try {
    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${config.cloudinary.cloudName}/video/destroy`,
      { method: 'POST', body: form }
    );

    const data = await res.json();
    return data?.result === 'ok';
  } catch (err) {
    console.error('Cloudinary delete failed:', err);
    return false;
  }
}