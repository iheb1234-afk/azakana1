// Connect a shop's account by hand (dev mode, before the OAuth "Connect" button exists).
// Usage: npm run add-channel -- <shop_id> <instagram|facebook> <account_id> <access_token> [expiry_days] [owner_email] [owner_telegram_chat_id]
//   instagram: account_id = IG professional account ID, token = Instagram user access token
//   facebook:  account_id = Page ID, token = Page access token
import { pool } from '../src/db.js';
import { encryptToken } from '../src/lib/crypto.js';

const [shopId, channel, accountId, token, days = '60', email, chatId] = process.argv.slice(2);
if (!shopId || !['instagram', 'facebook'].includes(channel) || !accountId || !token) {
  console.error('usage: npm run add-channel -- <shop_id> <instagram|facebook> <account_id> <token> [expiry_days] [owner_email] [telegram_chat_id]');
  process.exit(1);
}
await pool.query(
  `INSERT INTO shop_channels (shop_id, channel, external_account_id, access_token_enc, token_expiry)
   VALUES ($1,$2,$3,$4, now() + make_interval(days => $5))
   ON CONFLICT (channel, external_account_id) DO UPDATE
     SET access_token_enc = EXCLUDED.access_token_enc, token_expiry = EXCLUDED.token_expiry, status = 'active', shop_id = EXCLUDED.shop_id`,
  [Number(shopId), channel, accountId, encryptToken(token), Number(days)],
);
if (email) {
  await pool.query(
    `INSERT INTO owners (shop_id, login, telegram_chat_id) VALUES ($1,$2,$3)
     ON CONFLICT (login) DO UPDATE SET telegram_chat_id = EXCLUDED.telegram_chat_id`,
    [Number(shopId), email, chatId ?? null],
  );
}
console.log(`${channel} ${accountId} connected to shop ${shopId}`);
await pool.end();
