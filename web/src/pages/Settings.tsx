import { useEffect, useState } from 'react';
import { api, type Settings } from '../api';
import { useApp } from '../App';
import { Accounts } from './Accounts';

export function SettingsPage() {
  const { t, setLang, toast } = useApp();
  const [s, setS] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get<Settings>('/settings').then(setS).catch(() => toast(t('err_generic')));
  useEffect(() => { load(); }, []);
  if (!s) return <div className="skeleton" />;

  const dr = s.shop.delivery_rules;
  const setDr = (k: 'fee' | 'zones' | 'delay', v: string) =>
    setS({ ...s, shop: { ...s.shop, delivery_rules: { ...dr, [k]: k === 'fee' ? Number(v.replace(',', '.')) || 0 : v } } });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.patch('/settings', {
        shop: { system_prompt: s!.shop.system_prompt, delivery_rules: s!.shop.delivery_rules },
        owner: { lang: s!.owner.lang, notify_whatsapp: s!.owner.notify_whatsapp, telegram_chat_id: s!.owner.telegram_chat_id ?? '' },
      });
      setLang(s!.owner.lang);
      toast(t('saved'));
    } catch { toast(t('err_generic')); } finally { setBusy(false); }
  }
  async function logout() {
    await api.post('/auth/logout').catch(() => {});
    location.hash = '#/orders';
    location.reload();
  }

  return (
    <>
      <header className="sub"><h1>{t('tab_settings')}</h1></header>
      <Accounts channels={s.channels} onChange={load} />
      <form className="form" onSubmit={save}>
        <section className="panel">
          <h2>{t('shop_info')}</h2>
          <label className="field">
            <span className="muted">{t('shop_info_hint')}</span>
            <textarea rows={5} value={s.shop.system_prompt} onChange={(e) => setS({ ...s, shop: { ...s.shop, system_prompt: e.target.value } })} />
          </label>
        </section>

        <section className="panel">
          <h2>{t('delivery')}</h2>
          <label className="field"><span>{t('delivery_fee')}</span><input inputMode="decimal" dir="ltr" value={dr.fee ?? 0} onChange={(e) => setDr('fee', e.target.value)} /></label>
          <label className="field"><span>{t('zones')}</span><input value={dr.zones ?? ''} onChange={(e) => setDr('zones', e.target.value)} /></label>
          <label className="field"><span>{t('delay')}</span><input value={dr.delay ?? ''} onChange={(e) => setDr('delay', e.target.value)} /></label>
        </section>

        <section className="panel">
          <h2>{t('notifications')}</h2>
          <label className="check">
            <input type="checkbox" checked={s.owner.notify_whatsapp} onChange={(e) => setS({ ...s, owner: { ...s.owner, notify_whatsapp: e.target.checked } })} />
            <span>{t('notify_wa')} <b dir="ltr">+216 {s.owner.phone}</b></span>
          </label>
          <label className="field"><span>{t('telegram_id')}</span><input dir="ltr" value={s.owner.telegram_chat_id ?? ''} onChange={(e) => setS({ ...s, owner: { ...s.owner, telegram_chat_id: e.target.value } })} /></label>
        </section>

        <section className="panel">
          <h2>{t('language')}</h2>
          <div className="seg">
            {(['fr', 'ar'] as const).map((l) => (
              <button type="button" key={l} className={s.owner.lang === l ? 'on' : ''} aria-pressed={s.owner.lang === l}
                onClick={() => setS({ ...s, owner: { ...s.owner, lang: l } })}>{l === 'fr' ? 'Français' : 'العربية'}</button>
            ))}
          </div>
        </section>

        <div className="actions sticky">
          <button className="btn primary block" disabled={busy}>{t('save')}</button>
        </div>
      </form>
      <button className="link-btn logout" onClick={logout}>{t('logout')}</button>
    </>
  );
}
