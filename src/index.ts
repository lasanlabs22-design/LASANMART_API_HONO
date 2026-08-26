import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { config } from './config.js';
import { requestsRoute } from './routes/requests.js';

const app = new Hono();

app.get('/', (c) => {
  return c.json({
    status: 'ok',
    service: 'Lasan Mart API',
    time: new Date().toISOString(),
  });
});

app.route('/requests', requestsRoute);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Lasan Mart API running on http://localhost:${info.port}`);
});