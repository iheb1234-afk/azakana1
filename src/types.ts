export type Channel = 'instagram' | 'facebook' | 'whatsapp' | 'telegram' | 'test';

/** The only message shape the core ever sees. */
export interface NormalizedMessage {
  channel: Channel;
  accountId: string;          // receiving account (IG account ID, Page ID...) -> tenant lookup
  customerId: string;         // channel-specific sender ID
  messageId: string;          // platform message ID -> dedupe key
  text: string | null;
  media: { url: string; type: string }[];
  timestamp: number;          // ms
}

export interface ChannelLimits {
  maxTextLength: number;
  replyWindowHours: number;
}

export interface SendContext {
  accountId: string;
  accessToken: string;
}

export interface ChannelAdapter {
  channel: Channel;
  limits: ChannelLimits;
  /** Verify the platform signature on the raw body. */
  verifySignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  /** Turn a webhook payload into normalized messages. Echoes and receipts are dropped here. */
  parse(payload: unknown): NormalizedMessage[];
  /** Send a text reply; returns the platform message ID if any. */
  sendText(ctx: SendContext, customerId: string, text: string): Promise<string | null>;
}

export type ConversationState = 'idle' | 'collecting_order' | 'awaiting_confirmation' | 'handed_to_owner';

export interface Shop {
  id: number;
  name: string;
  languages: string[];
  system_prompt: string;
  delivery_rules: { fee?: number; zones?: string; delay?: string };
  daily_ai_cap: number;
  active: boolean;
}

export interface Conversation {
  id: number;
  shop_id: number;
  channel: Channel;
  customer_id: string;
  bot_paused: boolean;
  needs_attention: boolean;
  state: ConversationState;
}

export interface CatalogVariant {
  variant_id: number;
  product: string;
  description: string;
  label: string;
  price: number;
  in_stock: boolean;
}
