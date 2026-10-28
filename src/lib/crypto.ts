import crypto from 'node:crypto';
import { config } from '../config.js';

// AES-256-GCM for shop channel tokens. Format: base64(iv).base64(tag).base64(ciphertext)

function key(): Buffer {
  const k = Buffer.from(config.tokenKey, 'base64');
  if (k.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes base64');
  return k;
}

export function encryptToken(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decryptToken(packed: string): string {
  const [iv, tag, enc] = packed.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
