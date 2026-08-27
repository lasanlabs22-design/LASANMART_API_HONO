import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { config } from './config.js';
import { requestsRoute } from './routes/requests.js';
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

app.route('/requests', requestsRoute);
app.route('/admin', adminRoute);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Lasan Mart API running on http://localhost:${info.port}`);
});