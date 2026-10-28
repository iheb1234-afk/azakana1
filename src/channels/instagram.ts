import crypto from 'node:crypto';
import { config } from '../config.js';
import type { ChannelAdapter, NormalizedMessage } from '../types.js';

// Instagram API with Instagram Login. Field names follow Meta's webhook format at time of writing:
// VERIFY against the current docs before going live (plan section 9).

interface IgWebhook {
  object?: string;
  entry?: {
    id: string; // receiving IG professional account ID
    messaging?: {
      sender: { id: string };
      recipient: { id: string };
      timestamp: number;
      message?: {
        mid: string;
        text?: string;
        is_echo?: boolean;
        is_deleted?: boolean;
        attachments?: { type: string; payload?: { url?: string } }[];
      };
    }[];
  }[];
}

export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=') || !appSecret) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const got = header.slice('sha256='.length);
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex'));
}

export const instagram: ChannelAdapter = {
  channel: 'instagram',
  limits: { maxTextLength: 1000, replyWindowHours: 24 },

  verifySignature(rawBody, headers) {
    const h = headers['x-hub-signature-256'];
    return verifyMetaSignature(rawBody, Array.isArray(h) ? h[0] : h, config.meta.appSecret);
  },

  parse(payload) {
    const p = payload as IgWebhook;
    if (p.object !== 'instagram') return [];
    const out: NormalizedMessage[] = [];
    for (const entry of p.entry ?? []) {
      for (const ev of entry.messaging ?? []) {
        const m = ev.message;
        if (!m || m.is_echo || m.is_deleted) continue;          // receipts, reads, echoes, unsends
        if (ev.sender.id === entry.id) continue;                 // belt and braces: our own account
        const media = (m.attachments ?? [])
          .filter((a) => a.payload?.url)
          .map((a) => ({ url: a.payload!.url!, type: a.type }));
        const text = m.text?.trim() || null;
        if (!text && media.length === 0) continue;
        out.push({
          channel: 'instagram',
          accountId: entry.id,
          customerId: ev.sender.id,
          messageId: m.mid,
          text,
          media,
          timestamp: ev.timestamp,
        });
      }
    }
    return out;
  },

  async sendText(ctx, customerId, text) {
    const url = `${config.meta.igGraphUrl}/${config.meta.igApiVersion}/${ctx.accountId}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.accessToken}` },
      body: JSON.stringify({ recipient: { id: customerId }, message: { text: text.slice(0, 1000) } }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { message_id?: string; error?: { message?: string } };
    if (!res.ok) throw new Error(`instagram send ${res.status}: ${body.error?.message ?? 'unknown'}`);
    return body.message_id ?? null;
  },
};
