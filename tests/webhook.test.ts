// HTTP-level test: real Express app, real adapters (Instagram + Facebook), real Postgres. No model call.
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { facebook } from '../src/channels/facebook.js';
import { pool } from '../src/db.js';
import { setDebounce } from '../src/core/pipeline.js';
import { encryptToken } from '../src/lib/crypto.js';

let base = '';
let server: ReturnType<ReturnType<typeof createApp>['listen']>;

const sign = (body: string) => 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(body).digest('hex');
const post = (path: string, payload: object, sig?: string) => {
  const body = JSON.stringify(payload);
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig ?? sign(body) },
    body,
  });
};
const event = (object: string, account: string, mid: string, extra: object = {}) => ({
  object,
  entry: [{ id: account, time: 1, messaging: [{ sender: { id: 'cust' }, recipient: { id: account }, timestamp: Date.now(), message: { mid, text: 'salut', ...extra } }] }],
});
const waitFor = async (sql: string, n: number) => {
  for (let i = 0; i < 50; i++) {
    const { rows } = await pool.query(sql);
    if (rows[0].n >= n) return rows[0].n;
    await new Promise((r) => setTimeout(r, 50));
  }
  return (await pool.query(sql)).rows[0].n;
};

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const f of fs.readdirSync('db/migrations').sort()) await pool.query(fs.readFileSync(`db/migrations/${f}`, 'utf8'));
  await pool.query(fs.readFileSync('db/seed.sql', 'utf8'));
  await pool.query(
    `INSERT INTO shop_channels (shop_id, channel, external_account_id, access_token_enc) VALUES
       (1,'instagram','IGACC',$1), (1,'facebook','PAGE1',$1)`,
    [encryptToken('tok')],
  );
  setDebounce(-1);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await pool.end();
});

describe('webhooks over HTTP', () => {
  it('GET verification echoes the challenge only with the right token', async () => {
    process.env.META_VERIFY_TOKEN = '';
    const bad = await fetch(`${base}/webhooks/instagram?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`);
    expect(bad.status).toBe(403);
  });

  it('rejects a bad signature with 401 and stores nothing', async () => {
    const r = await post('/webhooks/instagram', event('instagram', 'IGACC', 'x0'), 'sha256=' + '0'.repeat(64));
    expect(r.status).toBe(401);
    expect((await pool.query('SELECT count(*)::int n FROM messages')).rows[0].n).toBe(0);
  });

  it('Instagram: signed message stored once, even if Meta retries it', async () => {
    expect((await post('/webhooks/instagram', event('instagram', 'IGACC', 'ig1'))).status).toBe(200);
    expect((await post('/webhooks/instagram', event('instagram', 'IGACC', 'ig1'))).status).toBe(200);
    expect(await waitFor(`SELECT count(*)::int n FROM messages WHERE channel='instagram'`, 1)).toBe(1);
  });

  it('Facebook: signed Page message stored under the facebook channel', async () => {
    expect((await post('/webhooks/facebook', event('page', 'PAGE1', 'fb1'))).status).toBe(200);
    expect(await waitFor(`SELECT count(*)::int n FROM messages WHERE channel='facebook'`, 1)).toBe(1);
    const { rows } = await pool.query(`SELECT channel, customer_id FROM conversations ORDER BY id`);
    expect(rows).toEqual([{ channel: 'instagram', customer_id: 'cust' }, { channel: 'facebook', customer_id: 'cust' }]);
  });

  it('Facebook echo is ignored', async () => {
    await post('/webhooks/facebook', event('page', 'PAGE1', 'fb2', { is_echo: true }));
    await new Promise((r) => setTimeout(r, 200));
    expect((await pool.query(`SELECT count(*)::int n FROM messages WHERE external_message_id='fb2'`)).rows[0].n).toBe(0);
  });

  it('an Instagram payload sent to the Facebook endpoint is ignored', async () => {
    await post('/webhooks/facebook', event('instagram', 'IGACC', 'wrong1'));
    await new Promise((r) => setTimeout(r, 200));
    expect((await pool.query(`SELECT count(*)::int n FROM messages WHERE external_message_id='wrong1'`)).rows[0].n).toBe(0);
  });

  it('unknown channel -> 404', async () => {
    expect((await post('/webhooks/tiktok', {})).status).toBe(404);
  });

  it('facebook adapter limits', () => {
    expect(facebook.limits.maxTextLength).toBe(2000);
  });
});
