import { config } from '../config.js';
import type { ChannelAdapter } from '../types.js';
import { graphSend, parseMessaging, signatureHeader, verifyMetaSignature } from './meta.js';

// Instagram API with Instagram Login. Webhook object = "instagram", entry.id = IG professional account ID.

export { verifyMetaSignature };

export const instagram: ChannelAdapter = {
  channel: 'instagram',
  limits: { maxTextLength: 1000, replyWindowHours: 24 },

  verifySignature: (raw, headers) => verifyMetaSignature(raw, signatureHeader(headers), config.meta.appSecret),

  parse: (payload) => parseMessaging(payload, 'instagram', 'instagram'),

  sendText: (ctx, customerId, text) =>
    graphSend(
      `${config.meta.igGraphUrl}/${config.meta.igApiVersion}/${ctx.accountId}/messages`,
      ctx.accessToken,
      { recipient: { id: customerId }, message: { text: text.slice(0, 1000) } },
      'instagram',
    ),
};
