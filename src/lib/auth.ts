import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { NextFunction, Request, Response } from 'express';
import { pool } from '../db.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const SESSION_DAYS = 30;
export const COOKIE = 'azk_session';

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored?.startsWith('scrypt$')) return false;
  const [, s, k] = stored.split('$');
  const key = await scrypt(pw, Buffer.from(s, 'base64'), 64);
  const expected = Buffer.from(k, 'base64');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export async function createSession(ownerId: number): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions (token_hash, owner_id, expires_at) VALUES ($1,$2, now() + make_interval(days => $3))`,
    [sha(token), ownerId, SESSION_DAYS],
  );
  return token;
}

export async function destroySession(token: string) {
  await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha(token)]);
}

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 86400_000,
    path: '/',
  };
}

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export interface OwnerCtx { id: number; shop_id: number; name: string; phone: string; lang: 'fr' | 'ar' }

declare module 'express-serve-static-core' {
  interface Request { owner?: OwnerCtx }
}

/** Every /api route behind this sees req.owner. All queries MUST filter by req.owner.shop_id. */
export async function requireOwner(req: Request, res: Response, next: NextFunction) {
  const token = readCookie(req, COOKIE);
  if (!token) return res.status(401).json({ error: 'not_logged_in' });
  const { rows } = await pool.query(
    `SELECT o.id, o.shop_id, o.name, o.phone, o.lang
       FROM sessions s JOIN owners o ON o.id = s.owner_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha(token)],
  );
  if (!rows[0]) return res.status(401).json({ error: 'not_logged_in' });
  req.owner = rows[0];
  next();
}

/** 5 failed attempts per phone per 15 min. */
export async function tooManyAttempts(phone: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM login_attempts WHERE phone = $1 AND created_at > now() - interval '15 minutes'`,
    [phone],
  );
  return rows[0].n >= 5;
}

export async function recordFailedAttempt(phone: string) {
  await pool.query('INSERT INTO login_attempts (phone) VALUES ($1)', [phone]);
}
