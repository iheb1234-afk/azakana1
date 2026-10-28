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
  meta: {
    appSecret: env('META_APP_SECRET', ''),
    verifyToken: env('META_VERIFY_TOKEN', ''),
    igGraphUrl: env('INSTAGRAM_GRAPH_URL', 'https://graph.instagram.com'),
    igApiVersion: env('INSTAGRAM_API_VERSION', 'v21.0'),
  },
  gemini: {
    apiKey: env('GEMINI_API_KEY', ''),
    model: env('GEMINI_MODEL', 'gemini-2.5-flash'),
    timeoutMs: 20_000,
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
