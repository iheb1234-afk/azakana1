export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'error');
  return data as T;
}

export const api = {
  get: <T>(p: string) => call<T>('GET', p),
  post: <T>(p: string, b: unknown = {}) => call<T>('POST', p, b),
  patch: <T>(p: string, b: unknown) => call<T>('PATCH', p, b),
};

export type Status = 'awaiting_confirmation' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled' | 'returned';

export interface Me {
  owner: { id: number; shop_id: number; name: string; phone: string; lang: 'fr' | 'ar' };
  shop: { id: number; name: string };
  counts: { to_prepare: number; attention: number; today: number };
}
export interface OrderRow {
  id: number; status: Status; customer_name: string; phone: string; address: string; total: number;
  created_at: string; confirmed_at: string | null; channel: string; summary: string;
}
export interface OrderDetail extends OrderRow {
  conversation_id: number; delivery_fee: number;
  items: { qty: number; unit_price: number; name: string; label: string }[];
  events: { status: Status; created_at: string }[];
}
export interface Variant { id: number; label: string; price_override: number | null; stock_qty: number; active: boolean }
export interface Product { id: number; name: string; description: string; price: number; active: boolean; variants: Variant[] }
export interface ConvRow {
  id: number; channel: string; customer_id: string; bot_paused: boolean; needs_attention: boolean;
  state: string; last_message_at: string; customer_name: string | null; last_text: string | null;
}
export interface Msg { id: number; direction: 'in' | 'out'; sent_by: 'bot' | 'owner' | 'customer'; text: string | null; media_url: string | null; status: string; created_at: string }
export interface ConvDetail extends ConvRow { messages: Msg[] }
export interface Settings {
  shop: { name: string; system_prompt: string; delivery_rules: { fee?: number; zones?: string; delay?: string } };
  owner: { name: string; phone: string; lang: 'fr' | 'ar'; notify_whatsapp: boolean; telegram_chat_id: string | null };
  channels: { channel: string; external_account_id: string; status: string; token_expiry: string | null }[];
}

export const dt = (n: number) => `${Number(Number(n).toFixed(3))} DT`;
