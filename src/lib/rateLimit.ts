import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';

/**
 * A small in-memory fixed-window limiter.
 *
 * One server instance on Railway, so memory is enough — if we ever run
 * several, this moves to Redis and nothing else changes.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

// Forget expired windows so the map can't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
}, 60_000).unref();

/** Counts one hit. True when the caller is still within the limit. */
export function hit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);

  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  b.count += 1;
  return b.count <= max;
}

/** Whether this key has already used up its window, without counting */
export function isBlocked(key: string, max: number): boolean {
  const b = buckets.get(key);
  return !!b && b.resetAt > Date.now() && b.count >= max;
}

/** The caller's address. Railway puts the real one first in x-forwarded-for. */
export function clientIp(c: Context): string {
  const fwd = c.req.header('x-forwarded-for');
  return fwd?.split(',')[0].trim() || c.req.header('x-real-ip') || 'unknown';
}

/**
 * Limits a route per verified phone (after requirePhone), falling back
 * to IP for public routes. Phones rather than IPs where we can — mobile
 * carriers put thousands of people behind one address.
 */
export function rateLimit(name: string, max: number, windowMs: number) {
  return createMiddleware(async (c, next) => {
    const who = (c.get('phone') as string | undefined) || clientIp(c);

    if (!hit(`${name}:${who}`, max, windowMs)) {
      return c.json(
        { error: 'Too many requests. Please wait a moment and try again.' },
        429
      );
    }

    await next();
  });
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
