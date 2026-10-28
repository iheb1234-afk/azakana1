import { config } from '../config.js';

async function send(chatId: string, text: string): Promise<void> {
  if (!config.telegram.botToken || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.log(JSON.stringify({ level: 'warn', msg: 'telegram send failed', error: String(e) }));
  }
}

/** Your own alerts (errors, stuck messages, token expiry). */
export const alertAdmin = (text: string) => send(config.telegram.adminChatId, text);

/** Shop owner notification. */
export const notifyOwner = (chatId: string | null, text: string) => (chatId ? send(chatId, text) : Promise.resolve());
