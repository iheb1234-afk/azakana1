import { config } from '../config.js';

// Meta login + token calls. Endpoints per Meta docs (Business Login for Instagram, Facebook Login).
// VERIFY against the current docs before going live; base URLs and versions are env-configurable.

async function json(res: Response, label: string) {
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || body?.error) throw new Error(`${label} ${res.status}: ${body?.error?.message ?? body?.error_message ?? 'unknown'}`);
  return body;
}
const get = (url: string, label: string) => fetch(url, { signal: AbortSignal.timeout(15_000) }).then((r) => json(r, label));
const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

export const redirectUri = (channel: 'instagram' | 'facebook') => `${config.publicUrl}/oauth/${channel}/callback`;

// ---------- Instagram (Instagram Login) ----------
export const IG_SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages'];

export function instagramAuthorizeUrl(state: string) {
  return `${config.meta.igAuthorizeUrl}?${q({
    client_id: config.meta.igAppId,
    redirect_uri: redirectUri('instagram'),
    response_type: 'code',
    scope: IG_SCOPES.join(','),
    state,
  })}`;
}

/** code -> long-lived token (60 days) + the IG professional account id that webhooks use as entry.id */
export async function instagramConnect(code: string) {
  const ex = await fetch(config.meta.igTokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: q({
      client_id: config.meta.igAppId,
      client_secret: config.meta.igAppSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri('instagram'),
      code: code.replace(/#_$/, ''),
    }),
    signal: AbortSignal.timeout(15_000),
  }).then((r) => json(r, 'ig code exchange'));
  const short = ex.data?.[0] ?? ex; // docs show {data:[...]}, some responses are flat
  const perms = String(short.permissions ?? '');
  if (perms && !perms.includes('instagram_business_manage_messages')) throw new Error('missing_permission');

  const g = `${config.meta.igGraphUrl}/${config.meta.igApiVersion}`;
  const long = await get(`${config.meta.igGraphUrl}/access_token?${q({
    grant_type: 'ig_exchange_token', client_secret: config.meta.igAppSecret, access_token: short.access_token,
  })}`, 'ig long-lived');
  const me = await get(`${g}/me?${q({ fields: 'user_id,username', access_token: long.access_token })}`, 'ig me');
  return {
    accountId: String(me.user_id ?? me.id),
    name: me.username ? `@${me.username}` : null,
    token: String(long.access_token),
    expiresAt: new Date(Date.now() + Number(long.expires_in ?? 5_184_000) * 1000),
  };
}

export async function instagramSubscribe(token: string) {
  const r = await fetch(`${config.meta.igGraphUrl}/${config.meta.igApiVersion}/me/subscribed_apps?${q({
    subscribed_fields: 'messages', access_token: token,
  })}`, { method: 'POST', signal: AbortSignal.timeout(15_000) }).then((x) => json(x, 'ig subscribe'));
  if (r.success === false) throw new Error('ig subscribe returned success=false');
}

export async function instagramUnsubscribe(token: string) {
  await fetch(`${config.meta.igGraphUrl}/${config.meta.igApiVersion}/me/subscribed_apps?${q({ access_token: token })}`,
    { method: 'DELETE', signal: AbortSignal.timeout(15_000) }).catch(() => {});
}

/** Must be >= 24h old and not expired. Returns new token + expiry. */
export async function instagramRefresh(token: string) {
  const r = await get(`${config.meta.igGraphUrl}/refresh_access_token?${q({ grant_type: 'ig_refresh_token', access_token: token })}`, 'ig refresh');
  return { token: String(r.access_token), expiresAt: new Date(Date.now() + Number(r.expires_in ?? 5_184_000) * 1000) };
}

// ---------- Facebook (Facebook Login -> Page token) ----------
export const FB_SCOPES = ['pages_show_list', 'pages_messaging', 'pages_manage_metadata'];

export function facebookAuthorizeUrl(state: string) {
  return `${config.meta.fbDialogUrl}/${config.meta.fbApiVersion}/dialog/oauth?${q({
    client_id: config.meta.appId,
    redirect_uri: redirectUri('facebook'),
    response_type: 'code',
    scope: FB_SCOPES.join(','),
    state,
  })}`;
}

/** code -> long-lived user token -> the Pages this person manages, each with a (non-expiring) Page token. */
export async function facebookPages(code: string): Promise<{ id: string; name: string; access_token: string }[]> {
  const g = `${config.meta.fbGraphUrl}/${config.meta.fbApiVersion}`;
  const short = await get(`${g}/oauth/access_token?${q({
    client_id: config.meta.appId, client_secret: config.meta.appSecret, redirect_uri: redirectUri('facebook'), code,
  })}`, 'fb code exchange');
  const long = await get(`${g}/oauth/access_token?${q({
    grant_type: 'fb_exchange_token', client_id: config.meta.appId, client_secret: config.meta.appSecret,
    fb_exchange_token: short.access_token,
  })}`, 'fb long-lived');
  const pages = await get(`${g}/me/accounts?${q({ fields: 'id,name,access_token,tasks', limit: '100', access_token: long.access_token })}`, 'fb pages');
  return (pages.data ?? [])
    .filter((p: any) => p.access_token && (!p.tasks || p.tasks.includes('MESSAGING') || p.tasks.includes('MANAGE')))
    .map((p: any) => ({ id: String(p.id), name: String(p.name ?? p.id), access_token: String(p.access_token) }));
}

export async function facebookSubscribe(pageId: string, pageToken: string) {
  const r = await fetch(`${config.meta.fbGraphUrl}/${config.meta.fbApiVersion}/${pageId}/subscribed_apps?${q({
    subscribed_fields: 'messages', access_token: pageToken,
  })}`, { method: 'POST', signal: AbortSignal.timeout(15_000) }).then((x) => json(x, 'fb subscribe'));
  if (r.success === false) throw new Error('fb subscribe returned success=false');
}

export async function facebookUnsubscribe(pageId: string, pageToken: string) {
  await fetch(`${config.meta.fbGraphUrl}/${config.meta.fbApiVersion}/${pageId}/subscribed_apps?${q({ access_token: pageToken })}`,
    { method: 'DELETE', signal: AbortSignal.timeout(15_000) }).catch(() => {});
}
