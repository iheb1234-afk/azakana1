import crypto from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { config } from '../config.js';
import { pool } from '../db.js';
import { decryptToken, encryptToken } from '../lib/crypto.js';
import { requireOwner } from '../lib/auth.js';
import { log, reportError } from '../lib/log.js';
import { alertAdmin } from '../notify/telegram.js';
import * as meta from './metaClient.js';

// Owner taps "Connecter Instagram" -> /oauth/instagram/start -> Meta login -> /oauth/instagram/callback
// -> we store the encrypted token, subscribe the account to our webhook -> back to Réglages.

type Ch = 'instagram' | 'facebook';
const STATE_TTL_MS = 15 * 60_000;

// state = base64url(json).hmac — ties the callback to the logged-in owner and expires.
function sign(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', config.tokenKey).update(body).digest('base64url');
  return `${body}.${mac}`;
}
function verify(state: string): { o: number; s: number; c: Ch; exp: number } | null {
  const [body, mac] = String(state).split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', config.tokenKey).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return p.exp > Date.now() ? p : null;
}

const back = (res: Response, params: Record<string, string>) =>
  res.redirect(`/#/settings?${new URLSearchParams(params).toString()}`);

/** Insert or update the channel row. Refuses to steal an account connected to another shop. */
export async function saveChannel(shopId: number, channel: Ch, accountId: string, name: string | null, token: string, expiresAt: Date | null) {
  const existing = (await pool.query(
    `SELECT shop_id, status FROM shop_channels WHERE channel = $1 AND external_account_id = $2`, [channel, accountId])).rows[0];
  if (existing && existing.shop_id !== shopId && existing.status === 'active') throw new Error('already_connected_elsewhere');
  await pool.query(
    `INSERT INTO shop_channels (shop_id, channel, external_account_id, access_token_enc, token_expiry, display_name, status, connected_at)
     VALUES ($1,$2,$3,$4,$5,$6,'active', now())
     ON CONFLICT (channel, external_account_id) DO UPDATE SET
       shop_id = EXCLUDED.shop_id, access_token_enc = EXCLUDED.access_token_enc, token_expiry = EXCLUDED.token_expiry,
       display_name = EXCLUDED.display_name, status = 'active', connected_at = now()`,
    [shopId, channel, accountId, encryptToken(token), expiresAt, name],
  );
}

export function oauthRoutes() {
  const r = express.Router();

  r.get('/:channel/start', requireOwner, (req: Request, res: Response) => {
    const channel = req.params.channel as Ch;
    if (channel !== 'instagram' && channel !== 'facebook') return res.sendStatus(404);
    const state = sign({ o: req.owner!.id, s: req.owner!.shop_id, c: channel, exp: Date.now() + STATE_TTL_MS, n: crypto.randomBytes(8).toString('hex') });
    res.redirect(channel === 'instagram' ? meta.instagramAuthorizeUrl(state) : meta.facebookAuthorizeUrl(state));
  });

  r.get('/:channel/callback', requireOwner, async (req: Request, res: Response) => {
    const channel = req.params.channel as Ch;
    const st = verify(String(req.query.state ?? ''));
    // Same owner who started, same channel, not expired.
    if (!st || st.c !== channel || st.o !== req.owner!.id) return back(res, { error: 'expired' });
    if (req.query.error || !req.query.code) return back(res, { error: 'denied' });
    const code = String(req.query.code);
    const shopId = req.owner!.shop_id;

    try {
      if (channel === 'instagram') {
        const acc = await meta.instagramConnect(code);
        await saveChannel(shopId, 'instagram', acc.accountId, acc.name, acc.token, acc.expiresAt);
        await meta.instagramSubscribe(acc.token);
        log('info', 'instagram connected', { shopId, account: acc.accountId });
        return back(res, { connected: 'instagram' });
      }

      const pages = await meta.facebookPages(code);
      if (pages.length === 0) return back(res, { error: 'no_pages' });
      if (pages.length === 1) {
        await connectPage(shopId, pages[0]);
        return back(res, { connected: 'facebook' });
      }
      // Several Pages: let the owner pick one.
      const id = crypto.randomBytes(16).toString('base64url');
      await pool.query(
        `INSERT INTO oauth_pending (id, shop_id, owner_id, pages_enc, expires_at) VALUES ($1,$2,$3,$4, now() + interval '15 minutes')`,
        [id, shopId, req.owner!.id, encryptToken(JSON.stringify(pages))],
      );
      return back(res, { pick: id });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== 'already_connected_elsewhere' && msg !== 'missing_permission') await reportError(`oauth ${channel}`, e, { shopId });
      return back(res, { error: ['already_connected_elsewhere', 'missing_permission'].includes(msg) ? msg : 'failed' });
    }
  });

  return r;
}

async function connectPage(shopId: number, p: { id: string; name: string; access_token: string }) {
  await saveChannel(shopId, 'facebook', p.id, p.name, p.access_token, null); // Page tokens from a long-lived user token don't expire
  await meta.facebookSubscribe(p.id, p.access_token);
  log('info', 'facebook page connected', { shopId, page: p.id });
}

/** JSON routes used by the owner app (mounted under /api, after requireOwner). */
export function channelApi() {
  const r = express.Router();

  r.get('/oauth/pending/:id', async (req, res) => {
    const row = (await pool.query(
      `SELECT pages_enc FROM oauth_pending WHERE id = $1 AND owner_id = $2 AND expires_at > now()`, [req.params.id, req.owner!.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'expired' });
    const pages = JSON.parse(decryptToken(row.pages_enc)) as { id: string; name: string }[];
    res.json(pages.map((p) => ({ id: p.id, name: p.name }))); // never send tokens to the browser
  });

  r.post('/oauth/pending/:id', async (req, res) => {
    const row = (await pool.query(
      `DELETE FROM oauth_pending WHERE id = $1 AND owner_id = $2 AND expires_at > now() RETURNING pages_enc, shop_id`,
      [req.params.id, req.owner!.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'expired' });
    const page = (JSON.parse(decryptToken(row.pages_enc)) as { id: string; name: string; access_token: string }[])
      .find((p) => p.id === String(req.body?.page_id));
    if (!page) return res.status(400).json({ error: 'unknown_page' });
    try {
      await connectPage(row.shop_id, page);
      res.json({ ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== 'already_connected_elsewhere') await reportError('oauth facebook pick', e, { shopId: row.shop_id });
      res.status(409).json({ error: msg === 'already_connected_elsewhere' ? msg : 'failed' });
    }
  });

  r.post('/channels/:id/disconnect', async (req, res) => {
    const ch = (await pool.query(
      `UPDATE shop_channels SET status = 'disabled' WHERE id = $1 AND shop_id = $2 AND status <> 'disabled'
       RETURNING channel, external_account_id, access_token_enc`, [Number(req.params.id), req.owner!.shop_id])).rows[0];
    if (!ch) return res.status(404).json({ error: 'not_found' });
    const token = decryptToken(ch.access_token_enc);
    if (ch.channel === 'instagram') await meta.instagramUnsubscribe(token);
    if (ch.channel === 'facebook') await meta.facebookUnsubscribe(ch.external_account_id, token);
    res.json({ ok: true });
  });

  return r;
}

/** Daily: refresh Instagram tokens that expire within 10 days. Alert on failure; mark expired ones. */
export async function refreshTokens(): Promise<{ refreshed: number; failed: number }> {
  const { rows } = await pool.query(
    `SELECT id, shop_id, access_token_enc, token_expiry FROM shop_channels
      WHERE channel = 'instagram' AND status = 'active' AND token_expiry IS NOT NULL
        AND token_expiry < now() + interval '10 days'
        AND COALESCE(refreshed_at, connected_at) < now() - interval '24 hours'`,
  );
  let refreshed = 0, failed = 0;
  for (const ch of rows) {
    try {
      const t = await meta.instagramRefresh(decryptToken(ch.access_token_enc));
      await pool.query('UPDATE shop_channels SET access_token_enc = $2, token_expiry = $3, refreshed_at = now() WHERE id = $1',
        [ch.id, encryptToken(t.token), t.expiresAt]);
      refreshed++;
    } catch (e) {
      failed++;
      if (new Date(ch.token_expiry) < new Date()) await pool.query(`UPDATE shop_channels SET status = 'token_expired' WHERE id = $1`, [ch.id]);
      await alertAdmin(`🔑 Instagram token refresh failed for shop ${ch.shop_id}: ${e instanceof Error ? e.message : e}. The owner must reconnect.`);
    }
  }
  return { refreshed, failed };
}
