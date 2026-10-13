import crypto from 'crypto';
import { config } from '../config.js';

/**
 * Cloudinary signs a set of parameters with our API secret. The caller
 * can then upload exactly those parameters — and nothing else — without
 * ever seeing the secret. The open preset is signed-only, so this is
 * the only way a file gets into our account.
 */
function sign(params: Record<string, string>) {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');

  return crypto
    .createHash('sha1')
    .update(toSign + config.cloudinary.apiSecret)
    .digest('hex');
}

/** Everything a client needs to upload one file into `folder` */
export function signedUpload(folder: string) {
  const timestamp = String(Math.round(Date.now() / 1000));

  return {
    cloudName: config.cloudinary.cloudName,
    apiKey: config.cloudinary.apiKey,
    folder,
    timestamp,
    signature: sign({ folder, timestamp }),
  };
}
