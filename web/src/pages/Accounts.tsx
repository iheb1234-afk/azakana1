import { useEffect, useState } from 'react';
import { api, type Settings } from '../api';
import { useApp } from '../App';
import type { Key } from '../i18n';

type Channel = Settings['channels'][number];

/** Connected Instagram / Facebook accounts + the result of a "Connect" round-trip (read from the URL). */
export function Accounts({ channels, onChange }: { channels: Channel[]; onChange: () => void }) {
  const { t, toast, lang } = useApp();
  const day = (iso: string) => new Date(iso).toLocaleDateString(lang === 'ar' ? 'ar-TN' : 'fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pickId, setPickId] = useState<string | null>(params.get('pick'));
  const [pages, setPages] = useState<{ id: string; name: string }[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const connected = params.get('connected');
    const error = params.get('error');
    if (connected) setNotice({ ok: true, text: t(`ok_${connected}` as Key) });
    if (error) setNotice({ ok: false, text: t((`oauth_${error}` in { oauth_expired: 1, oauth_denied: 1, oauth_missing_permission: 1, oauth_already_connected_elsewhere: 1, oauth_no_pages: 1 } ? `oauth_${error}` : 'oauth_failed') as Key) });
    if (connected || error) history.replaceState(null, '', '#/settings');
  }, []);

  useEffect(() => {
    if (!pickId) return;
    api.get<{ id: string; name: string }[]>(`/oauth/pending/${pickId}`)
      .then(setPages)
      .catch(() => { setPickId(null); setNotice({ ok: false, text: t('oauth_expired') }); history.replaceState(null, '', '#/settings'); });
  }, [pickId]);

  async function pick(pageId: string) {
    setBusy(true);
    try {
      await api.post(`/oauth/pending/${pickId}`, { page_id: pageId });
      setNotice({ ok: true, text: t('ok_facebook') });
      onChange();
    } catch (e: any) {
      setNotice({ ok: false, text: t(e?.code === 'already_connected_elsewhere' ? 'oauth_already_connected_elsewhere' : 'oauth_failed') });
    } finally {
      setBusy(false); setPickId(null); setPages(null);
      history.replaceState(null, '', '#/settings');
    }
  }

  async function disconnect(c: Channel) {
    if (!confirm(t('confirm_disconnect'))) return;
    try { await api.post(`/channels/${c.id}/disconnect`); onChange(); } catch { toast(t('err_generic')); }
  }

  const has = (ch: string) => channels.some((c) => c.channel === ch && c.status === 'active');

  return (
    <section className="panel">
      <h2>{t('accounts')}</h2>
      {notice && <p className={`notice${notice.ok ? ' ok' : ' bad'}`} role="status">{notice.text}</p>}

      {pages && (
        <div className="picker">
          <p>{t('pick_page')}</p>
          {pages.map((p) => (
            <button key={p.id} className="btn ghost block" disabled={busy} onClick={() => pick(p.id)}>
              <span dir="auto">{p.name}</span>
            </button>
          ))}
        </div>
      )}

      {channels.length === 0 && !pages && <p className="muted">{t('no_accounts')}</p>}
      <ul className="accounts">
        {channels.map((c) => (
          <li key={c.id} className={c.status === 'active' ? '' : 'warn'}>
            <span className={`ch ch-${c.channel}`} aria-hidden="true">{c.channel === 'facebook' ? 'f' : 'ig'}</span>
            <div className="acc-main">
              <strong dir="auto">{c.display_name ?? c.external_account_id}</strong>
              <span className="muted">
                {c.status === 'token_expired' ? t('token_expired')
                  : c.token_expiry ? `${c.channel === 'instagram' ? 'Instagram' : 'Facebook'} · ${t('expires')} ${day(c.token_expiry)}`
                  : c.channel === 'instagram' ? 'Instagram' : 'Facebook Messenger'}
              </span>
            </div>
            {c.status === 'token_expired'
              ? <a className="btn primary" href={`/oauth/${c.channel}/start`}>{t(c.channel === 'instagram' ? 'connect_ig' : 'connect_fb')}</a>
              : <button className="link-btn danger" onClick={() => disconnect(c)}>{t('disconnect')}</button>}
          </li>
        ))}
      </ul>

      <div className="actions">
        {!has('instagram') && <a className="btn primary" href="/oauth/instagram/start">{t('connect_ig')}</a>}
        {!has('facebook') && <a className="btn ghost" href="/oauth/facebook/start">{t('connect_fb')}</a>}
      </div>
    </section>
  );
}
