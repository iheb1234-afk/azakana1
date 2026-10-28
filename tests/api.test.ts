// Owner API over HTTP: login, shop isolation, orders, catalog, take-over + reply, settings, notifications.
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { registerAdapter } from '../src/channels/registry.js';
import { pool } from '../src/db.js';
import { confirmOrder, createOrderDraft } from '../src/core/orders.js';
import { setDebounce } from '../src/core/pipeline.js';
import { hashPassword } from '../src/lib/auth.js';
import { encryptToken } from '../src/lib/crypto.js';
import { notifyShop, setWhatsappSender } from '../src/notify/index.js';
import type { ChannelAdapter, Conversation, Shop } from '../src/types.js';

const sent: string[] = [];
const fake: ChannelAdapter = {
  channel: 'test', limits: { maxTextLength: 1000, replyWindowHours: 24 },
  verifySignature: () => true, parse: () => [],
  async sendText(_c, _to, text) { sent.push(text); return `o${sent.length}`; },
};
registerAdapter(fake);

let base = '';
let server: ReturnType<ReturnType<typeof createApp>['listen']>;

async function login(phone: string, password: string) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, password }),
  });
  return { status: r.status, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] };
}
function api(cookie: string) {
  const call = async (method: string, path: string, body?: object) => {
    const r = await fetch(`${base}/api${path}`, {
      method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b: object = {}) => call('POST', p, b),
    patch: (p: string, b: object) => call('PATCH', p, b),
  };
}
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;

let A: ReturnType<typeof api>;   // owner of shop 1
let B: ReturnType<typeof api>;   // owner of shop 2 (must never see shop 1)
let convId = 0;
let orderId = 0;

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const f of fs.readdirSync('db/migrations').sort()) await pool.query(fs.readFileSync(`db/migrations/${f}`, 'utf8'));
  await pool.query(fs.readFileSync('db/seed.sql', 'utf8'));
  await pool.query(`INSERT INTO shops (name) VALUES ('Autre boutique')`);
  await pool.query(`INSERT INTO shop_channels (shop_id, channel, external_account_id, access_token_enc) VALUES (1,'test','acc',$1)`, [encryptToken('t')]);
  await pool.query(`INSERT INTO owners (shop_id, phone, password_hash, name) VALUES (1,'99643383',$1,'Iheb'), (2,'22111222',$1,'Other')`,
    [await hashPassword('secret123')]);

  // A confirmed order from the bot, to work with.
  convId = (await q(`INSERT INTO conversations (shop_id, channel, customer_id) VALUES (1,'test','cust') RETURNING id`))[0].id;
  await pool.query(`INSERT INTO messages (conversation_id, channel, direction, sent_by, text, external_message_id, status) VALUES ($1,'test','in','customer','salut','m1','done')`, [convId]);
  const conv: Conversation = (await q('SELECT * FROM conversations WHERE id=$1', [convId]))[0];
  const shop: Shop = (await q('SELECT * FROM shops WHERE id=1'))[0];
  await createOrderDraft(conv, shop, { items: [{ variant_id: 1, qty: 2 }], customer_name: 'Sami', phone: '55123456', address: 'Sfax' });
  const r = await confirmOrder(convId);
  if (!r.ok) throw new Error('setup');
  orderId = r.orderId;

  setDebounce(-1);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  A = api((await login('99 643 383', 'secret123')).cookie);
  B = api((await login('22111222', 'secret123')).cookie);
});
afterAll(async () => { server.close(); await pool.end(); });

describe('auth', () => {
  it('wrong password -> 401, no cookie', async () => {
    const r = await login('99643383', 'nope');
    expect(r.status).toBe(401);
    expect(r.cookie).toBe('');
  });
  it('without a session -> 401', async () => {
    expect((await api('').get('/me')).status).toBe(401);
  });
  it('me returns owner, shop and counters', async () => {
    const r = await A.get('/me');
    expect(r.body.owner).toMatchObject({ shop_id: 1, name: 'Iheb', phone: '99643383' });
    expect(r.body.counts.to_prepare).toBe(1);
  });
  it('locks the phone after 5 failures', async () => {
    for (let i = 0; i < 5; i++) await login('22111222', 'bad');
    expect((await login('22111222', 'secret123')).status).toBe(429);
  });
});

describe('shop isolation', () => {
  it('owner B cannot see or touch shop 1 data', async () => {
    expect((await B.get('/orders')).body).toEqual([]);
    expect((await B.get(`/orders/${orderId}`)).status).toBe(404);
    expect((await B.post(`/orders/${orderId}/status`, { status: 'shipped' })).status).toBe(404);
    expect((await B.get('/products')).body).toEqual([]);
    expect((await B.post('/variants/1/stock', { delta: 5 })).status).toBe(404);
    expect((await B.patch('/products/1', { price: 1 })).status).toBe(404);
    expect((await B.get(`/conversations/${convId}`)).status).toBe(404);
    expect((await B.post(`/conversations/${convId}/reply`, { text: 'hack' })).status).toBe(404);
    expect(sent).toEqual([]);
  });
});

describe('orders', () => {
  it('lists with a readable summary', async () => {
    const [o] = (await A.get('/orders')).body;
    expect(o).toMatchObject({ id: orderId, status: 'confirmed', summary: '2 × Bleu de Chanel 50ml', total: 197 });
  });
  it('refuses illegal transitions', async () => {
    expect((await A.post(`/orders/${orderId}/status`, { status: 'delivered' })).status).toBe(409);
  });
  it('shipped -> returned puts stock back', async () => {
    expect(await q('SELECT stock_qty FROM variants WHERE id=1')).toEqual([{ stock_qty: 3 }]);
    expect((await A.post(`/orders/${orderId}/status`, { status: 'shipped' })).status).toBe(200);
    expect((await A.post(`/orders/${orderId}/status`, { status: 'returned' })).status).toBe(200);
    expect(await q('SELECT stock_qty FROM variants WHERE id=1')).toEqual([{ stock_qty: 5 }]);
    const d = (await A.get(`/orders/${orderId}`)).body;
    expect(d.events.map((e: any) => e.status)).toEqual(['shipped', 'returned']);
    expect(d.items).toEqual([{ qty: 2, unit_price: 95, name: 'Bleu de Chanel', label: '50ml' }]);
  });
});

describe('catalog', () => {
  it('adds a product with variants, then the bot catalog sees it', async () => {
    const r = await A.post('/products', { name: 'Oud Royal', price: 60, variants: [{ label: '30ml', stock_qty: 4 }, { label: '100ml', price_override: 150, stock_qty: 0 }] });
    expect(r.status).toBe(201);
    const p = (await A.get('/products')).body.find((x: any) => x.name === 'Oud Royal');
    expect(p.variants.map((v: any) => [v.label, v.price_override, v.stock_qty])).toEqual([['30ml', null, 4], ['100ml', 150, 0]]);
  });
  it('+/- stock never goes below zero', async () => {
    expect((await A.post('/variants/3/stock', { delta: -5 })).body).toEqual({ stock_qty: 0 });
    expect((await A.post('/variants/3/stock', { delta: 2 })).body).toEqual({ stock_qty: 2 });
  });
  it('rejects a product with no price', async () => {
    expect((await A.post('/products', { name: 'X' })).status).toBe(400);
  });
  it('hides a product', async () => {
    expect((await A.patch('/products/2', { active: false })).status).toBe(200);
    expect((await q('SELECT active FROM products WHERE id=2'))[0].active).toBe(false);
  });
});

describe('conversations', () => {
  it('owner reply is sent, stored as owner, and pauses the bot', async () => {
    const r = await A.post(`/conversations/${convId}/reply`, { text: 'Bonjour, ici la boutique' });
    expect(r.body).toEqual({ ok: true, delivered: true });
    expect(sent.at(-1)).toBe('Bonjour, ici la boutique');
    const c = (await A.get(`/conversations/${convId}`)).body;
    expect(c.bot_paused).toBe(true);
    expect(c.messages.at(-1)).toMatchObject({ direction: 'out', sent_by: 'owner', status: 'done' });
  });
  it('attention filter shows paused conversations; release gives it back to the bot', async () => {
    expect((await A.get('/conversations?filter=attention')).body.map((c: any) => c.id)).toEqual([convId]);
    await A.post(`/conversations/${convId}/release`);
    expect((await A.get('/conversations?filter=attention')).body).toEqual([]);
    expect((await q('SELECT bot_paused FROM conversations WHERE id=$1', [convId]))[0].bot_paused).toBe(false);
  });
});

describe('settings', () => {
  it('updates delivery fee and language', async () => {
    await A.patch('/settings', { shop: { delivery_rules: { fee: 8, zones: 'Grand Tunis', delay: '24h' } }, owner: { lang: 'ar' } });
    const s = (await A.get('/settings')).body;
    expect(s.shop.delivery_rules).toEqual({ fee: 8, zones: 'Grand Tunis', delay: '24h' });
    expect(s.owner.lang).toBe('ar');
    expect(s.channels).toHaveLength(1);
  });
});

describe('owner notifications', () => {
  it('WhatsApp template first, Telegram fallback on failure', async () => {
    const calls: any[] = [];
    setWhatsappSender(async (to, template, params) => { calls.push({ to, template, params }); });
    await notifyShop(1, { kind: 'new_order', orderId: 7, summary: '1 × Oud\nRoyal', total: '67 DT', recap: '' });
    expect(calls).toEqual([{ to: '99643383', template: 'azk_new_order', params: ['7', '1 × Oud\nRoyal', '67 DT'] }]);

    setWhatsappSender(async () => { throw new Error('template not approved'); });
    await expect(notifyShop(1, { kind: 'attention', reason: 'Photo', customer: 'c' })).resolves.toBeUndefined();
  });
});
