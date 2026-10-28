import express, { type Request, type Response, type NextFunction } from 'express';
import { pool, withTransaction } from '../db.js';
import { normalizePhone } from '../core/text.js';
import { cancelConfirmedOrder } from '../core/orders.js';
import { ownerReply } from '../core/pipeline.js';
import {
  COOKIE, cookieOptions, createSession, destroySession, readCookie, recordFailedAttempt,
  requireOwner, tooManyAttempts, verifyPassword,
} from '../lib/auth.js';
import { reportError } from '../lib/log.js';
import { channelApi } from '../oauth/routes.js';

// Owner API. RULE: every query filters by req.owner!.shop_id. Never trust an id from the client alone.

type H = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: H) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res).catch((e) => {
    reportError(`api ${req.method} ${req.path}`, e, { shopId: req.owner?.shop_id });
    next(e);
  });
const shop = (req: Request) => req.owner!.shop_id;
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
const bad = (res: Response, error: string, code = 400) => res.status(code).json({ error });

// Allowed owner status changes. Customer confirmation happens in the bot (stock-safe transaction).
const TRANSITIONS: Record<string, string[]> = {
  awaiting_confirmation: ['cancelled'],
  confirmed: ['shipped', 'cancelled'],
  shipped: ['delivered', 'returned'],
  delivered: ['returned'],
};

export function ownerApi() {
  const r = express.Router();
  r.use(express.json({ limit: '200kb' }));

  // ---------- auth ----------
  r.post('/auth/login', h(async (req, res) => {
    const phone = normalizePhone(String(req.body?.phone ?? ''));
    const password = String(req.body?.password ?? '');
    if (!phone || !password) return bad(res, 'invalid_credentials', 401);
    if (await tooManyAttempts(phone)) return bad(res, 'too_many_attempts', 429);
    const o = (await pool.query('SELECT id, password_hash FROM owners WHERE phone = $1', [phone])).rows[0];
    if (!o || !(await verifyPassword(password, o.password_hash))) {
      await recordFailedAttempt(phone);
      return bad(res, 'invalid_credentials', 401);
    }
    res.cookie(COOKIE, await createSession(o.id), cookieOptions());
    res.json({ ok: true });
  }));

  r.post('/auth/logout', h(async (req, res) => {
    const t = readCookie(req, COOKIE);
    if (t) await destroySession(t);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  }));

  r.use(requireOwner);
  r.use(channelApi());

  r.get('/me', h(async (req, res) => {
    const s = (await pool.query('SELECT id, name FROM shops WHERE id = $1', [shop(req)])).rows[0];
    const counts = (await pool.query(
      `SELECT
         (SELECT count(*)::int FROM orders WHERE shop_id = $1 AND status = 'confirmed') AS to_prepare,
         (SELECT count(*)::int FROM conversations WHERE shop_id = $1 AND needs_attention) AS attention,
         (SELECT count(*)::int FROM orders WHERE shop_id = $1 AND status = 'confirmed' AND confirmed_at::date = CURRENT_DATE) AS today`,
      [shop(req)],
    )).rows[0];
    res.json({ owner: req.owner, shop: s, counts });
  }));

  // ---------- orders ----------
  r.get('/orders', h(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    const { rows } = await pool.query(
      `SELECT o.id, o.status, o.customer_name, o.phone, o.address, o.total, o.created_at, o.confirmed_at, c.channel,
              (SELECT string_agg(oi.qty || ' × ' || p.name || ' ' || v.label, ', ' ORDER BY oi.id)
                 FROM order_items oi JOIN variants v ON v.id = oi.variant_id JOIN products p ON p.id = v.product_id
                WHERE oi.order_id = o.id) AS summary
         FROM orders o JOIN conversations c ON c.id = o.conversation_id
        WHERE o.shop_id = $1 AND ($2::text IS NULL OR o.status = $2) AND o.status <> 'draft'
        ORDER BY o.id DESC LIMIT 200`,
      [shop(req), status],
    );
    res.json(rows);
  }));

  r.get('/orders/:id', h(async (req, res) => {
    const o = (await pool.query(
      `SELECT o.*, c.channel FROM orders o JOIN conversations c ON c.id = o.conversation_id
        WHERE o.id = $1 AND o.shop_id = $2`, [num(req.params.id), shop(req)])).rows[0];
    if (!o) return bad(res, 'not_found', 404);
    const items = (await pool.query(
      `SELECT oi.qty, oi.unit_price, p.name, v.label FROM order_items oi
         JOIN variants v ON v.id = oi.variant_id JOIN products p ON p.id = v.product_id
        WHERE oi.order_id = $1 ORDER BY oi.id`, [o.id])).rows;
    const events = (await pool.query('SELECT status, created_at FROM order_events WHERE order_id = $1 ORDER BY id', [o.id])).rows;
    res.json({ ...o, items, events });
  }));

  r.post('/orders/:id/status', h(async (req, res) => {
    const id = num(req.params.id);
    const next = String(req.body?.status ?? '');
    const o = (await pool.query('SELECT status, conversation_id FROM orders WHERE id = $1 AND shop_id = $2', [id, shop(req)])).rows[0];
    if (!o) return bad(res, 'not_found', 404);
    if (!(TRANSITIONS[o.status] ?? []).includes(next)) return bad(res, `cannot_go_from_${o.status}_to_${next}`, 409);

    if (['cancelled', 'returned'].includes(next) && o.status !== 'awaiting_confirmation') {
      await cancelConfirmedOrder(id, next as 'cancelled' | 'returned'); // puts stock back
    } else {
      await pool.query('UPDATE orders SET status = $2 WHERE id = $1', [id, next]);
      if (o.status === 'awaiting_confirmation')
        await pool.query(`UPDATE conversations SET state = 'idle' WHERE id = $1 AND state = 'awaiting_confirmation'`, [o.conversation_id]);
    }
    await pool.query('INSERT INTO order_events (order_id, status, owner_id) VALUES ($1,$2,$3)', [id, next, req.owner!.id]);
    res.json({ ok: true, status: next });
  }));

  // ---------- catalog ----------
  r.get('/products', h(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.description, p.price, p.active, p.image_url,
              COALESCE(json_agg(json_build_object('id', v.id, 'label', v.label, 'price_override', v.price_override,
                       'stock_qty', v.stock_qty, 'active', v.active) ORDER BY v.id) FILTER (WHERE v.id IS NOT NULL), '[]') AS variants
         FROM products p LEFT JOIN variants v ON v.product_id = p.id
        WHERE p.shop_id = $1 GROUP BY p.id ORDER BY p.active DESC, p.name`,
      [shop(req)],
    );
    res.json(rows);
  }));

  r.post('/products', h(async (req, res) => {
    const { name, description = '', price, variants = [] } = req.body ?? {};
    if (!String(name ?? '').trim() || !(num(price) >= 0)) return bad(res, 'name_and_price_required');
    const id = await withTransaction(async (c) => {
      const p = (await c.query(
        'INSERT INTO products (shop_id, name, description, price) VALUES ($1,$2,$3,$4) RETURNING id',
        [shop(req), String(name).trim(), String(description), num(price)])).rows[0];
      const list = Array.isArray(variants) && variants.length ? variants : [{ label: 'Unique', stock_qty: 0 }];
      for (const v of list) {
        await c.query('INSERT INTO variants (product_id, label, price_override, stock_qty) VALUES ($1,$2,$3,$4)', [
          p.id, String(v.label ?? 'Unique').trim() || 'Unique',
          v.price_override === '' || v.price_override == null ? null : num(v.price_override),
          Math.max(0, Math.trunc(num(v.stock_qty) || 0)),
        ]);
      }
      return p.id;
    });
    res.status(201).json({ id });
  }));

  r.patch('/products/:id', h(async (req, res) => {
    const b = req.body ?? {};
    const r2 = await pool.query(
      `UPDATE products SET name = COALESCE($3, name), description = COALESCE($4, description),
              price = COALESCE($5, price), active = COALESCE($6, active)
        WHERE id = $1 AND shop_id = $2`,
      [num(req.params.id), shop(req), b.name ?? null, b.description ?? null,
       b.price === undefined ? null : num(b.price), typeof b.active === 'boolean' ? b.active : null],
    );
    if (!r2.rowCount) return bad(res, 'not_found', 404);
    res.json({ ok: true });
  }));

  r.post('/products/:id/variants', h(async (req, res) => {
    const p = (await pool.query('SELECT id FROM products WHERE id = $1 AND shop_id = $2', [num(req.params.id), shop(req)])).rows[0];
    if (!p) return bad(res, 'not_found', 404);
    const b = req.body ?? {};
    if (!String(b.label ?? '').trim()) return bad(res, 'label_required');
    const v = (await pool.query(
      'INSERT INTO variants (product_id, label, price_override, stock_qty) VALUES ($1,$2,$3,$4) RETURNING id',
      [p.id, String(b.label).trim(), b.price_override == null || b.price_override === '' ? null : num(b.price_override),
       Math.max(0, Math.trunc(num(b.stock_qty) || 0))])).rows[0];
    res.status(201).json({ id: v.id });
  }));

  // Variant ownership is checked through its product's shop.
  const ownVariant = async (req: Request) =>
    (await pool.query(
      `SELECT v.id FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = $1 AND p.shop_id = $2`,
      [num(req.params.id), shop(req)])).rows[0];

  r.patch('/variants/:id', h(async (req, res) => {
    if (!(await ownVariant(req))) return bad(res, 'not_found', 404);
    const b = req.body ?? {};
    await pool.query(
      `UPDATE variants SET label = COALESCE($2, label),
              price_override = CASE WHEN $3::boolean THEN $4::numeric ELSE price_override END,
              stock_qty = COALESCE($5, stock_qty), active = COALESCE($6, active)
        WHERE id = $1`,
      [num(req.params.id), b.label ?? null, 'price_override' in b,
       b.price_override == null || b.price_override === '' ? null : num(b.price_override),
       b.stock_qty === undefined ? null : Math.max(0, Math.trunc(num(b.stock_qty))),
       typeof b.active === 'boolean' ? b.active : null],
    );
    res.json({ ok: true });
  }));

  /** +1 / -1 buttons. Atomic, never below zero. */
  r.post('/variants/:id/stock', h(async (req, res) => {
    if (!(await ownVariant(req))) return bad(res, 'not_found', 404);
    const delta = Math.trunc(num(req.body?.delta));
    if (!Number.isFinite(delta)) return bad(res, 'delta_required');
    const v = (await pool.query(
      'UPDATE variants SET stock_qty = GREATEST(0, stock_qty + $2) WHERE id = $1 RETURNING stock_qty',
      [num(req.params.id), delta])).rows[0];
    res.json(v);
  }));

  // ---------- conversations ----------
  r.get('/conversations', h(async (req, res) => {
    const attention = req.query.filter === 'attention';
    const { rows } = await pool.query(
      `SELECT c.id, c.channel, c.customer_id, c.bot_paused, c.needs_attention, c.state, c.last_message_at,
              (SELECT o.customer_name FROM orders o WHERE o.conversation_id = c.id ORDER BY o.id DESC LIMIT 1) AS customer_name,
              (SELECT m.text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_text
         FROM conversations c
        WHERE c.shop_id = $1 AND ($2::boolean = FALSE OR c.needs_attention OR c.bot_paused)
        ORDER BY c.needs_attention DESC, c.last_message_at DESC LIMIT 200`,
      [shop(req), attention],
    );
    res.json(rows);
  }));

  const ownConv = async (req: Request) =>
    (await pool.query('SELECT * FROM conversations WHERE id = $1 AND shop_id = $2', [num(req.params.id), shop(req)])).rows[0];

  r.get('/conversations/:id', h(async (req, res) => {
    const c = await ownConv(req);
    if (!c) return bad(res, 'not_found', 404);
    const messages = (await pool.query(
      `SELECT id, direction, sent_by, text, media_url, status, created_at FROM messages
        WHERE conversation_id = $1 ORDER BY created_at, id LIMIT 500`, [c.id])).rows;
    const name = (await pool.query(
      'SELECT customer_name FROM orders WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1', [c.id])).rows[0]?.customer_name ?? null;
    res.json({ ...c, customer_name: name, messages });
  }));

  r.post('/conversations/:id/takeover', h(async (req, res) => {
    const c = await ownConv(req);
    if (!c) return bad(res, 'not_found', 404);
    await pool.query(`UPDATE conversations SET bot_paused = TRUE WHERE id = $1`, [c.id]);
    res.json({ ok: true });
  }));

  r.post('/conversations/:id/release', h(async (req, res) => {
    const c = await ownConv(req);
    if (!c) return bad(res, 'not_found', 404);
    await pool.query(
      `UPDATE conversations SET bot_paused = FALSE, needs_attention = FALSE,
              state = CASE WHEN state = 'handed_to_owner' THEN 'idle' ELSE state END
        WHERE id = $1`, [c.id]);
    res.json({ ok: true });
  }));

  r.post('/conversations/:id/seen', h(async (req, res) => {
    const c = await ownConv(req);
    if (!c) return bad(res, 'not_found', 404);
    await pool.query('UPDATE conversations SET needs_attention = FALSE WHERE id = $1', [c.id]);
    res.json({ ok: true });
  }));

  /** Owner replies from the app. Writing = taking over: the bot pauses until "Rendre au bot". */
  r.post('/conversations/:id/reply', h(async (req, res) => {
    const c = await ownConv(req);
    if (!c) return bad(res, 'not_found', 404);
    const text = String(req.body?.text ?? '').trim();
    if (!text) return bad(res, 'text_required');
    await pool.query('UPDATE conversations SET bot_paused = TRUE, needs_attention = FALSE WHERE id = $1', [c.id]);
    await ownerReply(c.id, text.slice(0, 2000));
    const last = (await pool.query(
      `SELECT status FROM messages WHERE conversation_id = $1 AND direction = 'out' ORDER BY id DESC LIMIT 1`, [c.id])).rows[0];
    res.json({ ok: true, delivered: last?.status === 'done' });
  }));

  // ---------- settings ----------
  r.get('/settings', h(async (req, res) => {
    const s = (await pool.query('SELECT name, system_prompt, delivery_rules FROM shops WHERE id = $1', [shop(req)])).rows[0];
    const o = (await pool.query('SELECT name, phone, lang, notify_whatsapp, telegram_chat_id FROM owners WHERE id = $1', [req.owner!.id])).rows[0];
    const channels = (await pool.query(
      `SELECT id, channel, external_account_id, display_name, status, token_expiry FROM shop_channels
        WHERE shop_id = $1 AND status <> 'disabled' ORDER BY id`, [shop(req)])).rows;
    res.json({ shop: s, owner: o, channels });
  }));

  r.patch('/settings', h(async (req, res) => {
    const { shop: s, owner: o } = req.body ?? {};
    if (s) {
      const fee = s.delivery_rules?.fee;
      await pool.query(
        `UPDATE shops SET system_prompt = COALESCE($2, system_prompt),
                delivery_rules = COALESCE($3::jsonb, delivery_rules) WHERE id = $1`,
        [shop(req), s.system_prompt ?? null,
         s.delivery_rules ? JSON.stringify({ fee: num(fee) >= 0 ? num(fee) : 0, zones: String(s.delivery_rules.zones ?? ''), delay: String(s.delivery_rules.delay ?? '') }) : null],
      );
    }
    if (o) {
      await pool.query(
        `UPDATE owners SET lang = COALESCE($2, lang), notify_whatsapp = COALESCE($3, notify_whatsapp),
                telegram_chat_id = CASE WHEN $4::boolean THEN NULLIF($5, '') ELSE telegram_chat_id END
          WHERE id = $1`,
        [req.owner!.id, ['fr', 'ar'].includes(o.lang) ? o.lang : null,
         typeof o.notify_whatsapp === 'boolean' ? o.notify_whatsapp : null,
         'telegram_chat_id' in o, String(o.telegram_chat_id ?? '')],
      );
    }
    res.json({ ok: true });
  }));

  return r;
}
