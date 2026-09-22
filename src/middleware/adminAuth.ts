import crypto from 'crypto';
import { createMiddleware } from 'hono/factory';
import { config } from '../config.js';
import { clientIp, hit, isBlocked } from '../lib/rateLimit.js';

/** Wrong guesses allowed per address before it is locked out for a while */
const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

/** Compares in constant time, so response timing leaks nothing */
function matches(given: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Guards every /admin route.
 *
 * The dashboard sends the shared password in an "x-admin-key" header.
 * This is deliberately simple — one password for the whole team.
 * When you need per-person accounts and an audit trail, this is the
 * single place that changes.
 *
 * Only failures are counted, so the console's normal traffic is never
 * slowed down — but guessing the password is.
 */
export const adminAuth = createMiddleware(async (c, next) => {
  const failKey = `admin-fail:${clientIp(c)}`;

  if (isBlocked(failKey, MAX_FAILURES)) {
    return c.json({ error: 'Too many attempts. Try again later.' }, 429);
  }

  const key = c.req.header('x-admin-key');

  if (!key || !matches(key, config.adminPassword)) {
    hit(failKey, MAX_FAILURES, LOCKOUT_MS);
    return c.json({ error: 'Unauthorised' }, 401);
  }

  await next();
});
