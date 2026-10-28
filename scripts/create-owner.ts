// Create (or reset the password of) a shop owner account.
// Usage: npm run create-owner -- <shop_id> <phone> <password> [name] [fr|ar]
import { pool } from '../src/db.js';
import { hashPassword } from '../src/lib/auth.js';
import { normalizePhone } from '../src/core/text.js';

const [shopId, rawPhone, password, name = '', lang = 'fr'] = process.argv.slice(2);
const phone = normalizePhone(rawPhone ?? '');
if (!shopId || !phone || !password || password.length < 6) {
  console.error('usage: npm run create-owner -- <shop_id> <phone 8 digits> <password min 6 chars> [name] [fr|ar]');
  process.exit(1);
}
await pool.query(
  `INSERT INTO owners (shop_id, phone, password_hash, name, lang) VALUES ($1,$2,$3,$4,$5)
   ON CONFLICT (phone) WHERE phone IS NOT NULL DO UPDATE SET password_hash = EXCLUDED.password_hash, shop_id = EXCLUDED.shop_id`,
  [Number(shopId), phone, await hashPassword(password), name, lang === 'ar' ? 'ar' : 'fr'],
);
console.log(`owner ${phone} ready for shop ${shopId}`);
await pool.end();
