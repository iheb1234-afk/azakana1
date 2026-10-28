// "Connect Instagram / Facebook" against a fake Meta server (no real Meta calls).
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { pool } from '../src/db.js';
import { hashPassword } from '../src/lib/auth.js';
import { decryptToken, encryptToken } from '../src/lib/crypto.js';
import { refreshTokens } from '../src/oauth/routes.js';

// ---------- fake Meta ----------
const calls: { method: string; path: string; query: Record<string, string>; body: string }[] = [];
let igPermissions = 'instagram_business_basic,instagram_business_manage_messages';
let igAccountId = 'IG_1784';
let fbPages = [{ id: 'PAGE_A', name: 'Demo Parfums', access_token: 'PT_A', tasks: ['MESSAGING'] }];
let refreshFails = false;

const meta = http.createServer((req, res) => {
  const u = new URL(req.url!, 'http://x');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls.push({ method: req.method!, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
    const send = (o: object, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const p = u.pathname;
    if (p === '/ig/token') return send({ data: [{ access_token: 'IG_SHORT', user_id: igAccountId, permissions: igPermissions }] });
    if (p === '/access_token') return send({ access_token: 'IG_LONG', token_type: 'bearer', expires_in: 5183944 });
    if (p === '/refresh_access_token') return refreshFails ? send({ error: { message: 'Session expired' } }, 400) : send({ access_token: 'IG_REFRESHED', expires_in: 5183944 });
    if (p.endsWith('/me') && u.searchParams.get('fields') === 'user_id,username') return send({ user_id: igAccountId, id: igAccountId, username: 'demo.parfums' });
    if (p.endsWith('/subscribed_apps')) return send({ success: true });
    if (p.endsWith('/oauth/access_token')) return send({ access_token: u.searchParams.get('fb_exchange_token') ? 'FB_LONG' : 'FB_SHORT' });
    if (p.endsWith('/me/accounts')) return send({ data: fbPages });
    send({ error: { message: `fake meta: no route ${p}` } }, 404);
  });
});

// ---------- app ----------
let base = '';
let server: http.Server;
const post = (path: string, cookie: string, body: object = {}) =>
  fetch(base + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (path: string, cookie: string) => fetch(base + path, { headers: { cookie }, redirect: 'manual' });
async function login(phone: string) {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, password: 'secret123' }) });
  return (r.headers.get('set-cookie') ?? '').split(';')[0];
}
/** Run the whole browser dance: start -> (Meta) -> callback. Returns where the owner lands. */
async function connect(channel: string, cookie: string, tamper?: (s: string) => string) {
  const start = await get(`/oauth/${channel}/start`, cookie);
  const to = new URL(start.headers.get('location')!);
  let state = to.searchParams.get('state')!;
  if (tamper) state = tamper(state);
  const cb = await get(`/oauth/${channel}/callback?code=CODE123%23_&state=${encodeURIComponent(state)}`, cookie);
  return { authorize: to, landing: cb.headers.get('location')! };
}
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;

let A = '', B = '';
beforeAll(async () => {
  await new Promise<void>((r) => meta.listen(0, r));
  const m = `http://127.0.0.1:${(meta.address() as AddressInfo).port}`;
  Object.assign(config.meta, {
    igAppId: 'IGAPP', igAppSecret: 'igsecret', appId: 'FBAPP', appSecret: 'fbsecret',
    igAuthorizeUrl: `${m}/ig/authorize`, igTokenUrl: `${m}/ig/token`, igGraphUrl: m, fbGraphUrl: m, fbDialogUrl: m,
  });
  config.publicUrl = 'https://azakana.test';

  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const f of fs.readdirSync('db/migrations').sort()) await pool.query(fs.readFileSync(`db/migrations/${f}`, 'utf8'));
  await pool.query(`INSERT INTO shops (name) VALUES ('Shop A'), ('Shop B')`);
  await pool.query(`INSERT INTO owners (shop_id, phone, password_hash) VALUES (1,'99643383',$1), (2,'22111222',$1)`, [await hashPassword('secret123')]);

  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  A = await login('99643383');
  B = await login('22111222');
});
afterAll(async () => { server.close(); meta.close(); await pool.end(); });
beforeEach(() => { calls.length = 0; });

describe('Connect Instagram', () => {
  it('start needs a logged-in owner', async () => {
    expect((await get('/oauth/instagram/start', '')).status).toBe(401);
  });

  it('full flow: authorize URL, token exchange, account saved encrypted, webhook subscribed', async () => {
    const { authorize, landing } = await connect('instagram', A);
    expect(authorize.pathname).toBe('/ig/authorize');
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      client_id: 'IGAPP', response_type: 'code', redirect_uri: 'https://azakana.test/oauth/instagram/callback',
      scope: 'instagram_business_basic,instagram_business_manage_messages',
    });
    expect(landing).toBe('/#/settings?connected=instagram');

    expect(calls.find((c) => c.path === '/ig/token')!.body).toMatch(/code=CODE123$/); // trailing "#_" stripped
    const [ch] = await q(`SELECT * FROM shop_channels WHERE channel='instagram'`);
    expect(ch).toMatchObject({ shop_id: 1, external_account_id: 'IG_1784', display_name: '@demo.parfums', status: 'active' });
    expect(ch.access_token_enc).not.toContain('IG_LONG');
    expect(decryptToken(ch.access_token_enc)).toBe('IG_LONG');
    expect(new Date(ch.token_expiry).getTime()).toBeGreaterThan(Date.now() + 59 * 86400_000);
    expect(calls.find((c) => c.path.endsWith('/me/subscribed_apps'))!.query).toMatchObject({ subscribed_fields: 'messages', access_token: 'IG_LONG' });
  });

  it('rejects a forged or foreign state', async () => {
    expect((await connect('instagram', A, (s) => s.slice(0, -2) + 'xx')).landing).toBe('/#/settings?error=expired');
    // B starts, A's browser finishes: refused
    const start = await get('/oauth/instagram/start', B);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cb = await get(`/oauth/instagram/callback?code=X&state=${encodeURIComponent(state)}`, A);
    expect(cb.headers.get('location')).toBe('/#/settings?error=expired');
  });

  it('owner refused the permissions', async () => {
    const start = await get('/oauth/instagram/start', A);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cb = await get(`/oauth/instagram/callback?error=access_denied&state=${encodeURIComponent(state)}`, A);
    expect(cb.headers.get('location')).toBe('/#/settings?error=denied');
  });

  it('messaging permission unticked -> clear error, nothing saved', async () => {
    igPermissions = 'instagram_business_basic'; igAccountId = 'IG_OTHER';
    expect((await connect('instagram', A)).landing).toBe('/#/settings?error=missing_permission');
    expect(await q(`SELECT 1 FROM shop_channels WHERE external_account_id='IG_OTHER'`)).toHaveLength(0);
    igPermissions = 'instagram_business_basic,instagram_business_manage_messages'; igAccountId = 'IG_1784';
  });

  it('an account already active on another shop cannot be taken', async () => {
    expect((await connect('instagram', B)).landing).toBe('/#/settings?error=already_connected_elsewhere');
    expect((await q(`SELECT shop_id FROM shop_channels WHERE external_account_id='IG_1784'`))[0].shop_id).toBe(1);
  });
});

describe('Connect Facebook', () => {
  it('one Page: connected directly with its Page token', async () => {
    const { authorize, landing } = await connect('facebook', A);
    expect(authorize.pathname).toMatch(/\/dialog\/oauth$/);
    expect(authorize.searchParams.get('scope')).toBe('pages_show_list,pages_messaging,pages_manage_metadata');
    expect(landing).toBe('/#/settings?connected=facebook');
    const [ch] = await q(`SELECT * FROM shop_channels WHERE channel='facebook'`);
    expect(ch).toMatchObject({ external_account_id: 'PAGE_A', display_name: 'Demo Parfums', token_expiry: null });
    expect(decryptToken(ch.access_token_enc)).toBe('PT_A');
    expect(calls.some((c) => c.path.endsWith('/PAGE_A/subscribed_apps') && c.query.access_token === 'PT_A')).toBe(true);
  });

  it('several Pages: owner picks one; tokens never reach the browser', async () => {
    fbPages = [
      { id: 'PAGE_B1', name: 'Boutique B', access_token: 'PT_B1', tasks: ['MESSAGING'] },
      { id: 'PAGE_B2', name: 'Autre page', access_token: 'PT_B2', tasks: ['MESSAGING'] },
    ];
    const { landing } = await connect('facebook', B);
    const pick = new URLSearchParams(landing.split('?')[1]).get('pick')!;
    expect(pick).toBeTruthy();

    const list = await (await get(`/api/oauth/pending/${pick}`, B)).json();
    expect(list).toEqual([{ id: 'PAGE_B1', name: 'Boutique B' }, { id: 'PAGE_B2', name: 'Autre page' }]);
    expect((await get(`/api/oauth/pending/${pick}`, A)).status).toBe(404); // other owner can't read it

    expect((await post(`/api/oauth/pending/${pick}`, B, { page_id: 'PAGE_B2' })).status).toBe(200);
    expect(await q(`SELECT shop_id, external_account_id FROM shop_channels WHERE channel='facebook' ORDER BY id`))
      .toEqual([{ shop_id: 1, external_account_id: 'PAGE_A' }, { shop_id: 2, external_account_id: 'PAGE_B2' }]);
    expect((await post(`/api/oauth/pending/${pick}`, B, { page_id: 'PAGE_B1' })).status).toBe(404); // single use
  });
});

describe('disconnect + settings', () => {
  it('settings list the connected accounts; disconnect unsubscribes and hides it', async () => {
    const s = await (await get('/api/settings', A)).json();
    expect(s.channels.map((c: any) => [c.channel, c.display_name])).toEqual([['instagram', '@demo.parfums'], ['facebook', 'Demo Parfums']]);
    const ig = s.channels[0];
    expect((await post(`/api/channels/${ig.id}/disconnect`, B)).status).toBe(404); // not B's
    expect((await post(`/api/channels/${ig.id}/disconnect`, A)).status).toBe(200);
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/me/subscribed_apps'))).toBe(true);
    expect((await (await get('/api/settings', A)).json()).channels).toHaveLength(1);
  });

  it('a disconnected account can be reconnected (even by another shop)', async () => {
    expect((await connect('instagram', A)).landing).toBe('/#/settings?connected=instagram');
  });
});

describe('Instagram token refresh', () => {
  it('refreshes tokens close to expiry, leaves fresh ones alone', async () => {
    await pool.query(`UPDATE shop_channels SET token_expiry = now() + interval '5 days', connected_at = now() - interval '2 days' WHERE channel='instagram'`);
    expect(await refreshTokens()).toEqual({ refreshed: 1, failed: 0 });
    const [ch] = await q(`SELECT access_token_enc, token_expiry FROM shop_channels WHERE channel='instagram'`);
    expect(decryptToken(ch.access_token_enc)).toBe('IG_REFRESHED');
    expect(await refreshTokens()).toEqual({ refreshed: 0, failed: 0 }); // now far from expiry
  });

  it('a failed refresh on an expired token marks it expired', async () => {
    refreshFails = true;
    await pool.query(`UPDATE shop_channels SET token_expiry = now() - interval '1 hour', refreshed_at = now() - interval '3 days', access_token_enc = $1 WHERE channel='instagram'`, [encryptToken('OLD')]);
    expect(await refreshTokens()).toEqual({ refreshed: 0, failed: 1 });
    expect((await q(`SELECT status FROM shop_channels WHERE channel='instagram'`))[0].status).toBe('token_expired');
    refreshFails = false;
  });
});
