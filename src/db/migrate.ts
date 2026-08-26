import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Pool } from 'pg';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const pool = new Pool({ connectionString: config.databaseUrl });
  console.log('Connecting to database...');
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');

  console.log('Running schema...');
  await pool.query(schema);

  console.log('Done. Tables created (or already existed).');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});