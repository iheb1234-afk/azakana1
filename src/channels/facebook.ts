import { config } from '../config.js';
import type { ChannelAdapter } from '../types.js';
import { graphSend, parseMessaging, signatureHeader, verifyMetaSignature } from './meta.js';

// Facebook Messenger (Pages). Webhook object = "page", entry.id = Page ID, sender.id = PSID.
// The token stored in shop_channels is the PAGE access token, not a user token.

export const facebook: ChannelAdapter = {
  channel: 'facebook',
  limits: { maxTextLength: 2000, replyWindowHours: 24 },

  verifySignature: (raw, headers) => verifyMetaSignature(raw, signatureHeader(headers), config.meta.appSecret),

  parse: (payload) => parseMessaging(payload, 'page', 'facebook'),

  sendText: (ctx, customerId, text) =>
    graphSend(
      `${config.meta.fbGraphUrl}/${config.meta.fbApiVersion}/${ctx.accountId}/messages`,
      ctx.accessToken,
      { recipient: { id: customerId }, messaging_type: 'RESPONSE', message: { text: text.slice(0, 2000) } },
      'facebook',
    ),
};
