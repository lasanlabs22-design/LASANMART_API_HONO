import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { config } from '../config.js';

/**
 * One Firebase Admin instance for the whole server.
 * We use it only to verify ID tokens the app sends us —
 * proving a phone number really belongs to whoever is asking.
 */
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: config.firebase.projectId,
      clientEmail: config.firebase.clientEmail,
      privateKey: config.firebase.privateKey,
    }),
  });
}

/**
 * Checks an ID token and returns the verified phone number,
 * or null if the token is missing, expired or has no phone.
 *
 * The number comes from Firebase, never from the request body —
 * that is the whole point.
 */
export async function verifiedPhoneFrom(
  authHeader: string | undefined
): Promise<string | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7).trim();
  if (!token) return null;

  try {
    const decoded = await getAuth().verifyIdToken(token);

    // Firebase gives it as +919876543210; we store 10 digits
    const raw = decoded.phone_number;
    if (!raw) return null;

    const digits = raw.replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : null;
  } catch (err: any) {
    console.log('Token verification failed:', err?.code || err?.message);
    return null;
  }
}
