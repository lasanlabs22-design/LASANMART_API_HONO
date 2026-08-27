import { createMiddleware } from 'hono/factory';
import { config } from '../config.js';

/**
 * Guards every /admin route.
 *
 * The dashboard sends the shared password in an "x-admin-key" header.
 * This is deliberately simple — one password for the whole team.
 * When you need per-person accounts and an audit trail, this is the
 * single place that changes.
 */
export const adminAuth = createMiddleware(async (c, next) => {
  const key = c.req.header('x-admin-key');
  

  if (!key || key !== config.adminPassword) {
    return c.json({ error: 'Unauthorised' }, 401);
  }

  await next();
});