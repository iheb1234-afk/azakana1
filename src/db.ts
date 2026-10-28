import pg from 'pg';
import { config } from './config.js';

// NUMERIC -> JS number (prices are small, 3 decimals is safe in float64)
pg.types.setTypeParser(1700, (v) => Number(v));
// BIGINT ids -> number
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export type Db = pg.Pool | pg.PoolClient;

export async function withTransaction<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
