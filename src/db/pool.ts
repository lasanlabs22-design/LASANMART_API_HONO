import { Pool } from 'pg';
import { config } from '../config.js';

/**
 * One shared pool for the whole server's lifetime.
 * Every endpoint that needs the database imports `pool` from here
 * instead of creating its own connection.
 */
export const pool = new Pool({
  connectionString: config.databaseUrl,
});

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
});