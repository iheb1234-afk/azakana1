import { useState } from 'react';
import { api, ApiError } from '../api';
import { useApp } from '../App';
import type { Key } from '../i18n';

export function Login({ onDone }: { onDone: () => void }) {
  const { t, lang, setLang } = useApp();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await api.post('/auth/login', { phone, password });
      onDone();
    } catch (e) {
      const code = e instanceof ApiError ? `err_${e.code}` : 'err_generic';
      setErr(t((code in { err_invalid_credentials: 1, err_too_many_attempts: 1 } ? code : 'err_generic') as Key));
    } finally { setBusy(false); }
  }

  return (
    <div className="login">
      <div className="login-mark" aria-hidden="true">
        <span>azakana</span>
      </div>
      <form onSubmit={submit} className="login-card">
        <h1>{t('login_title')}</h1>
        <p className="muted">{t('login_sub')}</p>
        <label className="field">
          <span>{t('phone')}</span>
          <input inputMode="tel" autoComplete="tel" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="99 123 456" required />
        </label>
        <label className="field">
          <span>{t('password')}</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn primary block" disabled={busy}>{t('login')}</button>
        <button type="button" className="link-btn" onClick={() => setLang(lang === 'fr' ? 'ar' : 'fr')}>
          {lang === 'fr' ? 'العربية' : 'Français'}
        </button>
      </form>
    </div>
  );
}
