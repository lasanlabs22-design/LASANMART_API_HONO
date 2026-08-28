import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { config } from './config.js';
import { requestsRoute } from './routes/requests.js';
import { notificationsRoute } from './routes/notifications.js';
import { reelsRoute } from './routes/reels.js';
import { adminRoute } from './routes/admin.js';

const app = new Hono();

/**
 * The console runs on a different domain, so the browser needs explicit
 * permission to call this API. Only these origins are allowed —
 * the admin password is the real protection, but there's no reason
 * to let any website on the internet try.
 *
 * The mobile app isn't affected by CORS at all; that's a browser rule.
 */
app.use(
  '/admin/*',
  cors({
    origin: [
      'https://lsm-admin-console.vercel.app', // ← replace with your Vercel URL
      'http://localhost:3001', // local development
      'http://localhost:3000',
    ],
    allowHeaders: ['Content-Type', 'x-admin-key'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  })
);

app.get('/', (c) => {
  return c.json({
    status: 'ok',
    service: 'Lasan Mart API',
    time: new Date().toISOString(),
  });
});

/* ---------- Customer-facing (used by the mobile app) ---------- */
app.route('/requests', requestsRoute);
app.route('/notifications', notificationsRoute);
app.route('/reels', reelsRoute);

/* ---------- Team-facing (used by the admin console) ---------- */
app.route('/admin', adminRoute);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Lasan Mart API running on http://localhost:${info.port}`);
});
