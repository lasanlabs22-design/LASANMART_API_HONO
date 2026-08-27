import { Pool } from 'pg';
import { config } from '../config.js';

/**
 * One shared pool for the whole server's lifetime.
 * Every endpoint that needs the database imports `pool` from here
 * instead of creating its own connection.
 */
export const pool = new Pool({
  connectionString: config.databaseUrl,

  ssl: config.databaseUrl.includes('localhost')
    ? false
    : { rejectUnauthorized: false },

  // Railway's public proxy drops idle connections. These settings
  // retire them on our side before the proxy kills them, so we
  // never hand out a dead connection.
  idleTimeoutMillis: 20000,        // close after 20s idle
  connectionTimeoutMillis: 10000,  // give up connecting after 10s
  max: 10,                         // plenty for a small team
  keepAlive: true,                 // ping so the proxy sees activity
});

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
});