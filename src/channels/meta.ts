import crypto from 'node:crypto';
import type { Channel, NormalizedMessage } from '../types.js';

// Shared by Instagram and Facebook Messenger: same signature scheme and same "messaging" event shape.
// VERIFY field names against the current Meta docs before going live (plan section 9).

export interface MetaWebhook {
  object?: string;
  entry?: {
    id: string; // receiving account: IG professional account ID or Facebook Page ID
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

export function signatureHeader(headers: Record<string, string | string[] | undefined>): string | undefined {
  const h = headers['x-hub-signature-256'];
  return Array.isArray(h) ? h[0] : h;
}

/** Keep only real customer messages: drop receipts, reads, echoes, unsends, empty events. */
export function parseMessaging(payload: unknown, object: 'instagram' | 'page', channel: Channel): NormalizedMessage[] {
  const p = payload as MetaWebhook;
  if (p?.object !== object) return [];
  const out: NormalizedMessage[] = [];
  for (const entry of p.entry ?? []) {
    for (const ev of entry.messaging ?? []) {
      const m = ev.message;
      if (!m || m.is_echo || m.is_deleted) continue;
      if (ev.sender?.id === entry.id) continue; // our own account
      const media = (m.attachments ?? [])
        .filter((a) => a.payload?.url)
        .map((a) => ({ url: a.payload!.url!, type: a.type }));
      const text = m.text?.trim() || null;
      if (!text && media.length === 0) continue;
      out.push({
        channel,
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
}

/** POST a text message to a Graph API messages endpoint. Returns the platform message id. */
export async function graphSend(url: string, token: string, body: object, label: string): Promise<string | null> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { message_id?: string; error?: { message?: string } };
  if (!res.ok) throw new Error(`${label} send ${res.status}: ${json.error?.message ?? 'unknown'}`);
  return json.message_id ?? null;
}
