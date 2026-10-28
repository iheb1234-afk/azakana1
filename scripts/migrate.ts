import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../src/db.js';

const dir = path.resolve('db/migrations');
await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  if (done.has(f)) continue;
  await pool.query('BEGIN');
  await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
  await pool.query('COMMIT');
  console.log('applied', f);
}
await pool.end();
