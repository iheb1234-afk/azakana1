// Fill the database with a realistic demo shop (for screenshots and prospect demos).
// Wipes everything first. Login afterwards: 99643383 / demo1234
import fs from 'node:fs';
import { pool } from '../src/db.js';
import { hashPassword } from '../src/lib/auth.js';
import { encryptToken } from '../src/lib/crypto.js';

await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
for (const f of fs.readdirSync('db/migrations').sort()) await pool.query(fs.readFileSync(`db/migrations/${f}`, 'utf8'));
await pool.query(fs.readFileSync('db/seed.sql', 'utf8'));
await pool.query(`INSERT INTO shop_channels (shop_id, channel, external_account_id, access_token_enc, token_expiry) VALUES
  (1,'instagram','17841400000000001',$1, now() + interval '52 days'), (1,'facebook','100000000000001',$1, now() + interval '52 days')`, [encryptToken('demo')]);
await pool.query(`INSERT INTO owners (shop_id, phone, password_hash, name) VALUES (1,'99643383',$1,'Iheb')`, [await hashPassword('demo1234')]);

type Line = [dir: 'in' | 'out', text: string, by?: 'bot' | 'owner', minutesAgo?: number];
async function conv(customer: string, channel: string, lines: Line[], opts: { paused?: boolean; attention?: boolean } = {}) {
  const c = (await pool.query(
    `INSERT INTO conversations (shop_id, channel, customer_id, bot_paused, needs_attention, last_message_at)
     VALUES (1,$1,$2,$3,$4, now() - make_interval(mins => $5)) RETURNING id`,
    [channel, customer, !!opts.paused, !!opts.attention, lines.at(-1)?.[3] ?? 0])).rows[0].id;
  for (const [dir, text, by, ago = 0] of lines) {
    await pool.query(
      `INSERT INTO messages (conversation_id, channel, direction, sent_by, text, status, external_message_id, created_at)
       VALUES ($1,$2,$3,$4,$5,'done',$6, now() - make_interval(mins => $7))`,
      [c, channel, dir, dir === 'in' ? 'customer' : by ?? 'bot', text, `${customer}-${Math.random()}`, ago]);
  }
  return c;
}
async function order(c: number, name: string, phone: string, address: string, items: [number, number][], status: string, hoursAgo: number) {
  let total = 7;
  for (const [v, q] of items) total += q * (await pool.query('SELECT COALESCE(v.price_override,p.price) p FROM variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1', [v])).rows[0].p;
  const o = (await pool.query(
    `INSERT INTO orders (shop_id, conversation_id, customer_name, phone, address, status, delivery_fee, total, created_at, confirmed_at)
     VALUES (1,$1,$2,$3,$4,$5,7,$6, now() - ($7::float * interval '1 hour'), now() - ($7::float * interval '1 hour')) RETURNING id`,
    [c, name, phone, address, status, total, hoursAgo])).rows[0].id;
  for (const [v, q] of items) await pool.query(
    'INSERT INTO order_items (order_id, variant_id, qty, unit_price) SELECT $1,$2,$3,COALESCE(v.price_override,p.price) FROM variants v JOIN products p ON p.id=v.product_id WHERE v.id=$2', [o, v, q]);
  if (status === 'shipped' || status === 'delivered') await pool.query(`INSERT INTO order_events (order_id, status, created_at) VALUES ($1,'shipped', now() - ($2::float * interval '1 hour'))`, [o, hoursAgo - 2]);
  if (status === 'delivered') await pool.query(`INSERT INTO order_events (order_id, status) VALUES ($1,'delivered')`, [o]);
}

const c1 = await conv('ig_yasmine', 'instagram', [
  ['in', 'Slt 9adeh la vie est belle ?', undefined, 95],
  ['out', 'Bonsoir 😊 La Vie Est Belle 50ml est à 90 DT, livraison 7 DT partout en Tunisie.', 'bot', 95],
  ['in', 'aady commande esmy Yasmine Trabelsi 22 456 789 La Marsa', undefined, 93],
  ['out', '📝 Récapitulatif de votre commande:\n• 1 × La Vie Est Belle 50ml: 90 DT\n• Livraison: 7 DT\n💰 Total: 97 DT\n👤 Yasmine Trabelsi | 📞 22456789\n📍 La Marsa\n\nVous confirmez la commande ? (oui / non)', 'bot', 93],
  ['in', 'ey', undefined, 92],
  ['out', '✅ Commande confirmée, merci ! Nous vous contacterons pour la livraison.', 'bot', 92],
]);
await order(c1, 'Yasmine Trabelsi', '22456789', 'La Marsa', [[5, 1]], 'confirmed', 1.5);

const c2 = await conv('fb_ahmed', 'facebook', [
  ['in', 'Bonsoir, bleu de chanel 100ml dispo ?', undefined, 300],
  ['out', 'Oui, Bleu de Chanel 100ml est disponible à 140 DT 👌', 'bot', 300],
  ['in', 'Ahmed Ben Salah, 98 112 233, Sousse centre', undefined, 298],
  ['in', 'oui', undefined, 297],
]);
await order(c2, 'Ahmed Ben Salah', '98112233', 'Sousse centre', [[2, 1]], 'confirmed', 5);

const c3 = await conv('ig_rania', 'instagram', [
  ['in', 'Ma commande pas encore arrivée ??', undefined, 12],
  ['out', 'Je transmets votre demande à la boutique, on vous répond très vite 🙏', 'bot', 12],
], { paused: true, attention: true });
await order(c3, 'Rania Gharbi', '50987654', 'Ariana, Ennasr 2', [[1, 2]], 'shipped', 30);

const c4 = await conv('ig_mehdi', 'instagram', [
  ['in', '[photo]', undefined, 4],
  ['out', 'Merci pour la photo 🙏 Vous cherchez quel produit exactement ? Je vérifie avec la boutique.', 'bot', 4],
], { attention: true });

const c5 = await conv('ig_salma', 'instagram', [['in', 'merci, bien reçu 🙏', undefined, 1500]]);
await order(c5, 'Salma Jaziri', '29334455', 'Bizerte', [[1, 1], [5, 1]], 'delivered', 50);
await order(c4, 'Mehdi Kefi', '93221100', 'Nabeul', [[4, 1]], 'cancelled', 70);

console.log('demo ready: login 99643383 / demo1234');
await pool.end();
