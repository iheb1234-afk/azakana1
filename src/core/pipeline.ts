import { config } from '../config.js';
import { pool } from '../db.js';
import { getAdapter } from '../channels/registry.js';
import { decryptToken } from '../lib/crypto.js';
import { log, reportError } from '../lib/log.js';
import { alertAdmin, notifyOwner } from '../notify/telegram.js';
import type { Channel, Conversation, NormalizedMessage, Shop } from '../types.js';
import { GeminiProvider, generateWithRetry, type Content, type ModelProvider } from './ai.js';
import { loadCatalog } from './catalog.js';
import { confirmOrder, createOrderDraft, declineOrder, pendingOrderRecap, type ActionOutcome, type DraftArgs } from './orders.js';
import { buildSystemPrompt } from './prompt.js';
import { isBareNo, isBareYes } from './text.js';

// ---------- wiring (swappable in tests) ----------
let model: ModelProvider = new GeminiProvider();
let debounceMs = 1500; // group "Salut" + "9adeh bleu chanel?" into one turn
export function setModel(m: ModelProvider) { model = m; }
export function setDebounce(ms: number) { debounceMs = ms; }

const FALLBACK = "Merci pour votre message 🙏 Un membre de l'équipe vous répond très vite.";
const PHOTO_REPLY = "Merci pour la photo 🙏 Vous cherchez quel produit exactement ? Je vérifie avec la boutique et on vous répond très vite.";
const DECLINED = "D'accord, commande annulée 👍 N'hésitez pas si vous avez une autre question.";
const CONFIRMED = (recap: string) => `✅ Commande confirmée, merci !\n\n${recap}\n\nNous vous contacterons pour la livraison.`;
const SOLD_OUT = (items: string[]) =>
  `Désolé 😔 ${items.join(', ')} vient d'être épuisé juste avant votre confirmation. Voulez-vous une autre variante ou un autre produit ?`;

// ---------- 1. ingest: tenant lookup + dedupe ----------
const timers = new Map<number, NodeJS.Timeout>();

/** Returns the conversation id, or null if duplicate / unknown account. */
export async function ingest(msg: NormalizedMessage): Promise<number | null> {
  const ch = (
    await pool.query(
      `SELECT sc.shop_id FROM shop_channels sc JOIN shops s ON s.id = sc.shop_id
        WHERE sc.channel = $1 AND sc.external_account_id = $2 AND sc.status = 'active' AND s.active`,
      [msg.channel, msg.accountId],
    )
  ).rows[0];
  if (!ch) {
    log('warn', 'unknown or inactive account', { channel: msg.channel, accountId: msg.accountId });
    return null;
  }

  const conv = (
    await pool.query(
      `INSERT INTO conversations (shop_id, channel, customer_id) VALUES ($1,$2,$3)
       ON CONFLICT (shop_id, channel, customer_id) DO UPDATE SET last_message_at = now()
       RETURNING id`,
      [ch.shop_id, msg.channel, msg.customerId],
    )
  ).rows[0];

  // THE dedupe: unique (channel, external_message_id), insert-or-ignore.
  const ins = await pool.query(
    `INSERT INTO messages (conversation_id, channel, direction, text, media_url, external_message_id, created_at)
     VALUES ($1,$2,'in',$3,$4,$5, to_timestamp($6 / 1000.0))
     ON CONFLICT (channel, external_message_id) DO NOTHING RETURNING id`,
    [conv.id, msg.channel, msg.text, msg.media[0]?.url ?? null, msg.messageId, msg.timestamp],
  );
  if (ins.rowCount === 0) {
    log('info', 'duplicate ignored', { channel: msg.channel, mid: msg.messageId });
    return null;
  }
  if (msg.media.length) void saveMedia(ins.rows[0].id, msg.media[0].url);
  schedule(conv.id);
  return conv.id;
}

function schedule(convId: number) {
  if (debounceMs < 0) return; // tests drive processConversation() by hand
  clearTimeout(timers.get(convId));
  timers.set(convId, setTimeout(() => {
    timers.delete(convId);
    processConversation(convId).catch((e) => reportError('processConversation', e, { conversationId: convId }));
  }, debounceMs));
}

/** Platform media URLs expire: copy the bytes right away. */
async function saveMedia(messageId: number, url: string) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`media ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await pool.query('INSERT INTO media (message_id, mime, data) VALUES ($1,$2,$3)', [
      messageId, res.headers.get('content-type'), buf,
    ]);
  } catch (e) {
    log('warn', 'media download failed', { messageId, error: String(e) });
  }
}

// ---------- 2. process one conversation, under a lock ----------
export async function processConversation(convId: number): Promise<void> {
  const lockClient = await pool.connect();
  try {
    // Per-conversation lock: one customer's messages are handled one at a time, in order.
    await lockClient.query('SELECT pg_advisory_lock($1)', [convId]);
    await flushPendingReplies(convId);
    await handleTurn(convId);
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [convId]).catch(() => {});
    lockClient.release();
  }
}

async function handleTurn(convId: number) {
  // Claim every pending inbound message of this conversation (new, failed-but-retryable, or stuck).
  const { rows: batch } = await pool.query(
    `UPDATE messages SET status = 'processing', attempts = attempts + 1, updated_at = now()
      WHERE id IN (
        SELECT id FROM messages
         WHERE conversation_id = $1 AND direction = 'in' AND attempts < $2
           AND (status IN ('received','failed')
                OR (status = 'processing' AND updated_at < now() - make_interval(secs => $3)))
         ORDER BY created_at, id)
      RETURNING id, text, media_url, attempts`,
    [convId, config.core.maxAttempts, config.core.stuckAfterSec],
  );
  if (batch.length === 0) return;
  batch.sort((a, b) => a.id - b.id);
  const ids = batch.map((m) => m.id);

  const conv: Conversation = (await pool.query('SELECT * FROM conversations WHERE id = $1', [convId])).rows[0];
  const shop: Shop = (await pool.query('SELECT * FROM shops WHERE id = $1', [conv.shop_id])).rows[0];
  const ids_ = { shopId: shop.id, conversationId: conv.id };

  try {
    // Owner took over: store only, notify, stop.
    if (conv.bot_paused) {
      await markInbound(ids, 'skipped');
      await notifyOwners(shop.id, `💬 Nouveau message (bot en pause) de ${conv.customer_id}:\n${batch.map((m) => m.text ?? '[photo]').join('\n')}`);
      return;
    }

    const texts = batch.map((m) => m.text).filter(Boolean) as string[];
    const hasMedia = batch.some((m) => m.media_url);
    const combined = texts.join('\n');

    let reply: string;
    if (hasMedia) {
      await pool.query('UPDATE conversations SET needs_attention = TRUE WHERE id = $1', [conv.id]);
      await notifyOwners(shop.id, `📷 Photo reçue de ${conv.customer_id}. À vérifier dans la conversation.`);
    }

    if (hasMedia && texts.length === 0) {
      reply = PHOTO_REPLY;
    } else if (conv.state === 'awaiting_confirmation' && texts.length === 1 && isBareYes(combined)) {
      reply = await doConfirm(conv, shop);                       // bare "oui" fast path, decided in code
    } else if (conv.state === 'awaiting_confirmation' && texts.length === 1 && isBareNo(combined)) {
      await declineOrder(conv.id);
      reply = DECLINED;
    } else {
      reply = await runModel(conv, shop, ids, hasMedia);
    }

    await queueReply(conv, ids, reply);
    await flushPendingReplies(conv.id);
  } catch (e) {
    const attempts = Math.max(...batch.map((m) => m.attempts));
    await markInbound(ids, 'failed');
    await reportError(`turn failed (attempt ${attempts}/${config.core.maxAttempts})`, e, ids_);
    if (attempts >= config.core.maxAttempts) {
      await pool.query('UPDATE conversations SET needs_attention = TRUE WHERE id = $1', [conv.id]);
      await queueReply(conv, [], FALLBACK).then(() => flushPendingReplies(conv.id)).catch(() => {});
    }
  }
}

async function doConfirm(conv: Conversation, shop: Shop): Promise<string> {
  const r = await confirmOrder(conv.id);
  if (r.ok) {
    await notifyOwners(shop.id, `🛒 Nouvelle commande #${r.orderId} (${conv.channel})\n\n${r.recap}`);
    return CONFIRMED(r.recap);
  }
  if (r.reason === 'out_of_stock') return SOLD_OUT(r.items);
  return "Je n'ai pas de commande en attente. Vous souhaitez commander quel produit ?";
}

// ---------- 3. model loop: the model proposes, the code decides ----------
async function runModel(conv: Conversation, shop: Shop, batchIds: number[], hasMedia: boolean): Promise<string> {
  if (await overCap(shop)) {
    await alertAdmin(`💸 AI cap reached for shop ${shop.id} (${shop.daily_ai_cap}/day)`);
    await pool.query('UPDATE conversations SET needs_attention = TRUE WHERE id = $1', [conv.id]);
    return FALLBACK;
  }

  const [catalog, pendingRecap, contents] = await Promise.all([
    loadCatalog(pool, shop.id),
    pendingOrderRecap(pool, conv.id),
    loadHistory(conv.id),
  ]);
  if (hasMedia) contents.push({ role: 'user', parts: [{ text: '[Le client a aussi envoyé une photo, la boutique est prévenue.]' }] });
  const system = buildSystemPrompt({ shop, catalog, state: conv.state, pendingRecap });

  for (let round = 0; round < config.core.maxToolRounds; round++) {
    let res;
    try {
      res = await generateWithRetry(model, { system, contents: mergeRoles(contents) });
    } catch (e) {
      await reportError('gemini failed', e, { shopId: shop.id, conversationId: conv.id });
      await pool.query('UPDATE conversations SET needs_attention = TRUE WHERE id = $1', [conv.id]);
      return FALLBACK;
    }
    await recordUsage(shop.id, res.usage);

    if (!res.functionCall) return res.text ?? FALLBACK;

    const outcome = await execute(conv, shop, res.functionCall.name, res.functionCall.args);
    log('info', 'tool', { conv: conv.id, tool: res.functionCall.name, outcome: outcome.kind });
    if (outcome.kind === 'reply') return outcome.text;

    // Rejected: tell the model why and let it rephrase for the customer.
    contents.push({ role: 'model', parts: [{ functionCall: res.functionCall }] });
    contents.push({ role: 'user', parts: [{ functionResponse: { name: res.functionCall.name, response: { error: outcome.error } } }] });
  }
  return FALLBACK;
}

async function execute(conv: Conversation, shop: Shop, name: string, args: Record<string, unknown>): Promise<ActionOutcome> {
  const fresh: Conversation = (await pool.query('SELECT * FROM conversations WHERE id = $1', [conv.id])).rows[0];
  switch (name) {
    case 'create_order_draft':
      return createOrderDraft(fresh, shop, args as unknown as DraftArgs);
    case 'customer_confirms':
      if (fresh.state !== 'awaiting_confirmation')
        return { kind: 'rejected', error: "Aucune commande en attente de confirmation. Ne confirme rien; continue la conversation." };
      return { kind: 'reply', text: await doConfirm(fresh, shop) };
    case 'customer_declines':
      if (fresh.state !== 'awaiting_confirmation')
        return { kind: 'rejected', error: 'Aucune commande en attente. Continue la conversation normalement.' };
      await declineOrder(fresh.id);
      return { kind: 'reply', text: DECLINED };
    case 'handoff_to_owner':
      await pool.query(
        `UPDATE conversations SET state = 'handed_to_owner', bot_paused = TRUE, needs_attention = TRUE WHERE id = $1`,
        [fresh.id],
      );
      await notifyOwners(shop.id, `🙋 Le bot passe la main (${fresh.channel}, client ${fresh.customer_id}).\nRaison: ${String(args.reason ?? '-')}`);
      return { kind: 'reply', text: "Je transmets votre demande à la boutique, on vous répond très vite 🙏" };
    default:
      return { kind: 'rejected', error: `Outil inconnu ${name}.` };
  }
}

// ---------- history, replies, helpers ----------
async function loadHistory(convId: number): Promise<Content[]> {
  const { rows } = await pool.query(
    `SELECT direction, text, media_url FROM (
       SELECT * FROM messages WHERE conversation_id = $1
        ORDER BY created_at DESC, id DESC LIMIT $2) t
     ORDER BY created_at, id`,
    [convId, config.core.historyLimit],
  );
  return rows
    .filter((r) => r.text || r.media_url)
    .map((r) => ({ role: r.direction === 'in' ? 'user' : 'model', parts: [{ text: r.text ?? '[photo]' }] }));
}

/** Gemini prefers alternating roles: merge consecutive same-role text turns. */
function mergeRoles(contents: Content[]): Content[] {
  const out: Content[] = [];
  for (const c of contents) {
    const prev = out[out.length - 1];
    const plain = c.parts.every((p) => p.text !== undefined);
    if (prev && prev.role === c.role && plain && prev.parts.every((p) => p.text !== undefined)) {
      prev.parts = [{ text: `${prev.parts.map((p) => p.text).join('\n')}\n${c.parts.map((p) => p.text).join('\n')}` }];
    } else out.push({ role: c.role, parts: [...c.parts] });
  }
  return out;
}

/** Reply is stored BEFORE sending, in the same step that closes the inbound batch: a crash can't lose it. */
async function queueReply(conv: Conversation, inboundIds: number[], text: string) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO messages (conversation_id, channel, direction, text, status) VALUES ($1,$2,'out',$3,'received')`,
      [conv.id, conv.channel, text],
    );
    if (inboundIds.length) await c.query(`UPDATE messages SET status = 'done', updated_at = now() WHERE id = ANY($1)`, [inboundIds]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

async function flushPendingReplies(convId: number) {
  const { rows } = await pool.query(
    `SELECT m.id, m.text, m.attempts, c.channel, c.customer_id, sc.external_account_id, sc.access_token_enc
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN shop_channels sc ON sc.shop_id = c.shop_id AND sc.channel = c.channel AND sc.status = 'active'
      WHERE m.conversation_id = $1 AND m.direction = 'out' AND m.status IN ('received','failed') AND m.attempts < $2
      ORDER BY m.id`,
    [convId, config.core.maxAttempts],
  );
  for (const r of rows) {
    const adapter = getAdapter(r.channel as Channel);
    try {
      const extId = await adapter.sendText(
        { accountId: r.external_account_id, accessToken: decryptToken(r.access_token_enc) },
        r.customer_id,
        r.text,
      );
      await pool.query(
        `UPDATE messages SET status = 'done', external_message_id = $2, attempts = attempts + 1, updated_at = now() WHERE id = $1`,
        [r.id, extId],
      );
    } catch (e) {
      await pool.query(`UPDATE messages SET status = 'failed', attempts = attempts + 1, updated_at = now() WHERE id = $1`, [r.id]);
      await reportError(`send failed (attempt ${r.attempts + 1})`, e, { conversationId: convId });
      break; // keep order: don't send reply N+1 before N
    }
  }
}

async function markInbound(ids: number[], status: 'done' | 'failed' | 'skipped') {
  await pool.query(`UPDATE messages SET status = $2, updated_at = now() WHERE id = ANY($1)`, [ids, status]);
}

async function notifyOwners(shopId: number, text: string) {
  const { rows } = await pool.query('SELECT telegram_chat_id FROM owners WHERE shop_id = $1 AND telegram_chat_id IS NOT NULL', [shopId]);
  await Promise.all(rows.map((r) => notifyOwner(r.telegram_chat_id, text)));
}

async function overCap(shop: Shop): Promise<boolean> {
  const r = await pool.query('SELECT calls FROM ai_usage WHERE shop_id = $1 AND day = CURRENT_DATE', [shop.id]);
  return (r.rows[0]?.calls ?? 0) >= shop.daily_ai_cap;
}

async function recordUsage(shopId: number, u: { input: number; output: number }) {
  await pool.query(
    `INSERT INTO ai_usage (shop_id, calls, input_tokens, output_tokens) VALUES ($1, 1, $2, $3)
     ON CONFLICT (shop_id, day) DO UPDATE SET calls = ai_usage.calls + 1,
       input_tokens = ai_usage.input_tokens + EXCLUDED.input_tokens,
       output_tokens = ai_usage.output_tokens + EXCLUDED.output_tokens`,
    [shopId, u.input, u.output],
  );
}

// ---------- 4. sweeper: retries, crashed messages, token expiry ----------
export async function sweep() {
  const { rows } = await pool.query(
    `SELECT DISTINCT conversation_id FROM messages
      WHERE attempts < $1 AND (
            (direction = 'in'  AND status = 'failed')
         OR (direction = 'in'  AND status = 'received' AND created_at < now() - interval '10 seconds')
         OR (direction = 'in'  AND status = 'processing' AND updated_at < now() - make_interval(secs => $2))
         OR (direction = 'out' AND status IN ('received','failed')))`,
    [config.core.maxAttempts, config.core.stuckAfterSec],
  );
  for (const r of rows) {
    await processConversation(r.conversation_id).catch((e) => reportError('sweep', e, { conversationId: r.conversation_id }));
  }
  return rows.length;
}

let lastTokenCheck = 0;
export async function checkTokens() {
  if (Date.now() - lastTokenCheck < 6 * 3600_000) return;
  lastTokenCheck = Date.now();
  const { rows } = await pool.query(
    `SELECT shop_id, channel, token_expiry FROM shop_channels
      WHERE status = 'active' AND token_expiry IS NOT NULL AND token_expiry < now() + interval '7 days'`,
  );
  for (const r of rows) await alertAdmin(`🔑 Token ${r.channel} for shop ${r.shop_id} expires ${r.token_expiry.toISOString()}`);
}
