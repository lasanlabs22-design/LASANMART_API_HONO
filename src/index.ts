import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { config } from './config.js';
import { requestsRoute } from './routes/requests.js';
import { notificationsRoute } from './routes/notifications.js';
import { adminRoute } from './routes/admin.js';

const app = new Hono();

// The dashboard runs on a different domain, so the browser needs
// permission to call this API. The mobile app isn't affected by CORS.
app.use('/admin/*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'x-admin-key'],
  allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
}));

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

/* ---------- Team-facing (used by the admin console) ---------- */
app.route('/admin', adminRoute);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Lasan Mart API running on http://localhost:${info.port}`);
});