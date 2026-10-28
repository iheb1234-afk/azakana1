import { pool, withTransaction, type Db } from '../db.js';
import type { Conversation, Shop } from '../types.js';
import { formatTnd, normalizePhone } from './text.js';

// "The model proposes, the code decides." Every check here is authoritative.

export interface DraftArgs {
  items: { variant_id: number; qty: number }[];
  customer_name: string;
  phone: string;
  address: string;
}

export type ActionOutcome =
  | { kind: 'reply'; text: string }                     // final text, written by code (exact prices)
  | { kind: 'rejected'; error: string };                // goes back to the model to rephrase

export async function pendingOrderRecap(db: Db, conversationId: number): Promise<string | null> {
  const id = await pendingOrderId(db, conversationId);
  return id ? recapText(db, id) : null;
}

async function pendingOrderId(db: Db, conversationId: number): Promise<number | null> {
  const { rows } = await db.query(
    `SELECT id FROM orders WHERE conversation_id = $1 AND status = 'awaiting_confirmation'
      ORDER BY id DESC LIMIT 1`,
    [conversationId],
  );
  return rows[0]?.id ?? null;
}

export async function recapText(db: Db, orderId: number): Promise<string> {
  const o = (await db.query('SELECT * FROM orders WHERE id = $1', [orderId])).rows[0];
  const items = (
    await db.query(
      `SELECT oi.qty, oi.unit_price, p.name, v.label
         FROM order_items oi JOIN variants v ON v.id = oi.variant_id JOIN products p ON p.id = v.product_id
        WHERE oi.order_id = $1 ORDER BY oi.id`,
      [orderId],
    )
  ).rows;
  const lines = items.map((i) => `• ${i.qty} × ${i.name} ${i.label}: ${formatTnd(i.qty * i.unit_price)}`);
  return [
    '📝 Récapitulatif de votre commande:',
    ...lines,
    o.delivery_fee > 0 ? `• Livraison: ${formatTnd(o.delivery_fee)}` : null,
    `💰 Total: ${formatTnd(o.total)}`,
    `👤 ${o.customer_name} | 📞 ${o.phone}`,
    `📍 ${o.address}`,
  ].filter(Boolean).join('\n');
}

export async function createOrderDraft(conv: Conversation, shop: Shop, args: DraftArgs): Promise<ActionOutcome> {
  const phone = normalizePhone(String(args.phone ?? ''));
  if (!phone) return { kind: 'rejected', error: 'Numéro de téléphone invalide (8 chiffres tunisiens). Redemande-le.' };
  const name = String(args.customer_name ?? '').trim();
  const address = String(args.address ?? '').trim();
  if (name.length < 2) return { kind: 'rejected', error: 'Nom manquant. Demande le nom complet.' };
  if (address.length < 2) return { kind: 'rejected', error: 'Adresse manquante. Demande l’adresse.' };
  if (!Array.isArray(args.items) || args.items.length === 0)
    return { kind: 'rejected', error: 'Aucun produit. Demande quel produit et quelle variante.' };

  return withTransaction(async (c) => {
    let subtotal = 0;
    const lines: { variant_id: number; qty: number; price: number }[] = [];
    for (const it of args.items) {
      const qty = Math.trunc(Number(it.qty));
      if (!(qty >= 1 && qty <= 20)) return { kind: 'rejected', error: `Quantité invalide (${it.qty}).` } as const;
      const { rows } = await c.query(
        `SELECT v.id, v.label, v.stock_qty, p.name, COALESCE(v.price_override, p.price) AS price
           FROM variants v JOIN products p ON p.id = v.product_id
          WHERE v.id = $1 AND p.shop_id = $2 AND p.active AND v.active`,
        [Math.trunc(Number(it.variant_id)), shop.id],
      );
      const v = rows[0];
      if (!v) return { kind: 'rejected', error: `variant_id ${it.variant_id} n'existe pas. Utilise un variant_id du catalogue ou demande la variante.` } as const;
      if (v.stock_qty < qty)
        return { kind: 'rejected', error: `${v.name} ${v.label} est épuisé (ou stock insuffisant). Dis-le et propose une alternative en stock.` } as const;
      subtotal += v.price * qty;
      lines.push({ variant_id: v.id, qty, price: v.price });
    }
    const fee = Number(shop.delivery_rules?.fee ?? 0);

    // A new draft replaces any older pending one in this conversation (customer changed their mind).
    await c.query(
      `UPDATE orders SET status = 'cancelled' WHERE conversation_id = $1 AND status IN ('draft','awaiting_confirmation')`,
      [conv.id],
    );
    const order = (
      await c.query(
        `INSERT INTO orders (shop_id, conversation_id, customer_name, phone, address, status, delivery_fee, total)
         VALUES ($1,$2,$3,$4,$5,'awaiting_confirmation',$6,$7) RETURNING id`,
        [shop.id, conv.id, name, phone, address, fee, subtotal + fee],
      )
    ).rows[0];
    for (const l of lines) {
      await c.query('INSERT INTO order_items (order_id, variant_id, qty, unit_price) VALUES ($1,$2,$3,$4)', [
        order.id, l.variant_id, l.qty, l.price,
      ]);
    }
    await c.query(`UPDATE conversations SET state = 'awaiting_confirmation' WHERE id = $1`, [conv.id]);
    const recap = await recapText(c, order.id);
    return { kind: 'reply', text: `${recap}\n\nVous confirmez la commande ? (oui / non)` } as const;
  });
}

export type ConfirmResult =
  | { ok: true; orderId: number; recap: string }
  | { ok: false; reason: 'no_pending' }
  | { ok: false; reason: 'out_of_stock'; items: string[] };

/**
 * THE critical step. One transaction: lock variant rows, check, decrement, confirm.
 * Two customers on the last item cannot both succeed.
 */
export async function confirmOrder(conversationId: number): Promise<ConfirmResult> {
  return withTransaction(async (c) => {
    const o = (
      await c.query(
        `SELECT id FROM orders WHERE conversation_id = $1 AND status = 'awaiting_confirmation'
          ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [conversationId],
      )
    ).rows[0];
    if (!o) return { ok: false, reason: 'no_pending' } as const;

    // Lock in id order so two orders never deadlock each other.
    const items = (
      await c.query(
        `SELECT oi.variant_id, oi.qty, v.stock_qty, v.label, p.name
           FROM order_items oi
           JOIN variants v ON v.id = oi.variant_id
           JOIN products p ON p.id = v.product_id
          WHERE oi.order_id = $1
          ORDER BY oi.variant_id
          FOR UPDATE OF v`,
        [o.id],
      )
    ).rows;

    const missing = items.filter((i) => i.stock_qty < i.qty).map((i) => `${i.name} ${i.label}`);
    if (missing.length) {
      await c.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [o.id]);
      await c.query(`UPDATE conversations SET state = 'collecting_order' WHERE id = $1`, [conversationId]);
      return { ok: false, reason: 'out_of_stock', items: missing } as const;
    }
    for (const i of items) {
      await c.query('UPDATE variants SET stock_qty = stock_qty - $1 WHERE id = $2', [i.qty, i.variant_id]);
    }
    await c.query(`UPDATE orders SET status = 'confirmed', confirmed_at = now() WHERE id = $1`, [o.id]);
    await c.query(`UPDATE conversations SET state = 'idle' WHERE id = $1`, [conversationId]);
    return { ok: true, orderId: o.id, recap: await recapText(c, o.id) } as const;
  });
}

export async function declineOrder(conversationId: number): Promise<boolean> {
  const r = await pool.query(
    `UPDATE orders SET status = 'cancelled' WHERE conversation_id = $1 AND status = 'awaiting_confirmation'`,
    [conversationId],
  );
  await pool.query(`UPDATE conversations SET state = 'idle' WHERE id = $1`, [conversationId]);
  return (r.rowCount ?? 0) > 0;
}

/** Owner-side cancellation after confirmation puts stock back. (Used by the owner app in Phase 3.) */
export async function cancelConfirmedOrder(orderId: number, status: 'cancelled' | 'returned' = 'cancelled') {
  await withTransaction(async (c) => {
    const o = (await c.query(`SELECT status FROM orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
    if (!o || !['confirmed', 'shipped', 'delivered'].includes(o.status)) return;
    await c.query(
      `UPDATE variants v SET stock_qty = v.stock_qty + oi.qty FROM order_items oi
        WHERE oi.order_id = $1 AND oi.variant_id = v.id`,
      [orderId],
    );
    await c.query(`UPDATE orders SET status = $2 WHERE id = $1`, [orderId, status]);
  });
}
