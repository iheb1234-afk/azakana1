import 'dotenv/config';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing env var ${name}`);
  return v;
}

export const config = {
  port: Number(env('PORT', '3000')),
  databaseUrl: env('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/azakana'),
  tokenKey: env('TOKEN_ENCRYPTION_KEY', ''),
  publicUrl: env('PUBLIC_URL', 'http://localhost:3000'),   // where Meta sends the owner back after login
  meta: {
    appId: env('META_APP_ID', ''),                           // Facebook Login (Messenger)
    appSecret: env('META_APP_SECRET', ''),
    igAppId: env('INSTAGRAM_APP_ID', ''),                    // Instagram Login (its own app id / secret)
    igAppSecret: env('INSTAGRAM_APP_SECRET', ''),
    igAuthorizeUrl: env('INSTAGRAM_AUTHORIZE_URL', 'https://www.instagram.com/oauth/authorize'),
    igTokenUrl: env('INSTAGRAM_TOKEN_URL', 'https://api.instagram.com/oauth/access_token'),
    fbDialogUrl: env('FACEBOOK_DIALOG_URL', 'https://www.facebook.com'),
    verifyToken: env('META_VERIFY_TOKEN', ''),
    igGraphUrl: env('INSTAGRAM_GRAPH_URL', 'https://graph.instagram.com'),
    igApiVersion: env('INSTAGRAM_API_VERSION', 'v24.0'),
    fbGraphUrl: env('FACEBOOK_GRAPH_URL', 'https://graph.facebook.com'),
    fbApiVersion: env('FACEBOOK_API_VERSION', 'v24.0'),
  },
  gemini: {
    apiKey: env('GEMINI_API_KEY', ''),
    model: env('GEMINI_MODEL', 'gemini-2.5-flash'),
    timeoutMs: 20_000,
  },
  whatsapp: {
    token: env('WHATSAPP_TOKEN', ''),                    // system user token with whatsapp_business_messaging
    phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID', ''),  // Azakana's sender number (not the shop's)
    templateLang: env('WHATSAPP_TEMPLATE_LANG', 'fr'),
  },
  telegram: {
    botToken: env('TELEGRAM_BOT_TOKEN', ''),
    adminChatId: env('ADMIN_TELEGRAM_CHAT_ID', ''),
  },
  core: {
    historyLimit: 20,          // messages sent to the model
    maxAttempts: 3,            // per incoming message
    stuckAfterSec: 120,        // "processing" longer than this = crashed, re-queue
    retryEverySec: 30,
    maxToolRounds: 3,          // model <-> tools loop guard
  },
};
