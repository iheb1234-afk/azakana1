import fs from 'node:fs';
import { pool } from '../src/db.js';

await pool.query(fs.readFileSync('db/seed.sql', 'utf8'));
console.log('seeded demo shop');
await pool.end();
