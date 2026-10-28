import { pool } from '../db.js';
import { log } from '../lib/log.js';
import { notifyOwner as telegram } from './telegram.js';
import { sendTemplate, whatsappEnabled } from './whatsapp.js';

// Owner notifications: WhatsApp first (when configured and the owner opted in), Telegram as fallback.

export type OwnerEvent =
  | { kind: 'new_order'; orderId: number; summary: string; total: string; recap: string }
  | { kind: 'attention'; reason: string; customer: string; detail?: string };

export type Sender = (to: string, template: string, params: string[]) => Promise<void>;
let waSend: Sender = sendTemplate;
let waOn = whatsappEnabled;
/** Tests swap the WhatsApp sender. */
export function setWhatsappSender(s: Sender, enabled = true) { waSend = s; waOn = () => enabled; }

function telegramText(e: OwnerEvent): string {
  if (e.kind === 'new_order') return `🛒 Nouvelle commande #${e.orderId}\n\n${e.recap}`;
  return `🔔 ${e.reason} (client ${e.customer})${e.detail ? `\n${e.detail}` : ''}`;
}

export async function notifyShop(shopId: number, e: OwnerEvent): Promise<void> {
  const { rows } = await pool.query(
    'SELECT phone, notify_whatsapp, telegram_chat_id FROM owners WHERE shop_id = $1',
    [shopId],
  );
  await Promise.all(rows.map(async (o) => {
    if (waOn() && o.notify_whatsapp && o.phone) {
      try {
        if (e.kind === 'new_order') await waSend(o.phone, 'azk_new_order', [String(e.orderId), e.summary, e.total]);
        else await waSend(o.phone, 'azk_attention', [e.reason, e.customer]);
        return;
      } catch (err) {
        log('warn', 'whatsapp notify failed, falling back to telegram', { shopId, error: String(err) });
      }
    }
    await telegram(o.telegram_chat_id, telegramText(e));
  }));
}
