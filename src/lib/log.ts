import { pool } from '../db.js';
import { alertAdmin } from '../notify/telegram.js';

type Fields = Record<string, unknown>;

/** Structured JSON log line (Render/Railway/Fly collect stdout). Never pass tokens here. */
export function log(level: 'info' | 'warn' | 'error', msg: string, fields: Fields = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }));
}

/** Write to error_log and alert you on Telegram. Never throws. */
export async function reportError(step: string, err: unknown, ids: { shopId?: number; conversationId?: number } = {}) {
  const text = err instanceof Error ? err.message : String(err);
  log('error', step, { ...ids, error: text });
  try {
    await pool.query('INSERT INTO error_log (shop_id, conversation_id, step, error) VALUES ($1,$2,$3,$4)', [
      ids.shopId ?? null, ids.conversationId ?? null, step, text.slice(0, 2000),
    ]);
  } catch { /* db down: stdout is enough */ }
  await alertAdmin(`⚠️ ${step}\nshop=${ids.shopId ?? '-'} conv=${ids.conversationId ?? '-'}\n${text.slice(0, 500)}`);
}
