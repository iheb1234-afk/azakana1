import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api';
import { dict, type Key, type Lang } from './i18n';
import { Login } from './pages/Login';
import { Orders } from './pages/Orders';
import { OrderView } from './pages/OrderView';
import { Catalog } from './pages/Catalog';
import { Chats } from './pages/Chats';
import { ChatView } from './pages/ChatView';
import { SettingsPage } from './pages/Settings';

interface Ctx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (k: Key) => string;
  me: Me | null;
  refreshMe: () => void;
  go: (hash: string) => void;
  toast: (msg: string) => void;
}
const AppCtx = createContext<Ctx>(null!);
export const useApp = () => useContext(AppCtx);

function useHash() {
  const [hash, setHash] = useState(location.hash || '#/orders');
  useEffect(() => {
    const on = () => setHash(location.hash || '#/orders');
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash;
}

const savedLang = (): Lang => {
  try { return (localStorage.getItem('azk_lang') as Lang) || 'fr'; } catch { return 'fr'; }
};

export function App() {
  const [lang, setLangState] = useState<Lang>(savedLang);
  const [me, setMe] = useState<Me | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [toastMsg, setToast] = useState('');
  const hash = useHash();

  const setLang = (l: Lang) => {
    setLangState(l);
    try { localStorage.setItem('azk_lang', l); } catch { /* private mode */ }
  };
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }, [lang]);

  const refreshMe = useCallback(() => {
    api.get<Me>('/me')
      .then((m) => { setMe(m); setAuthed(true); })
      .catch((e) => { if (e instanceof ApiError && e.status === 401) setAuthed(false); });
  }, []);
  useEffect(() => { refreshMe(); const i = setInterval(refreshMe, 20_000); return () => clearInterval(i); }, [refreshMe]);

  const toast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 2500); };
  const ctx: Ctx = {
    lang, setLang, t: (k) => dict[lang][k], me, refreshMe,
    go: (h) => { location.hash = h; }, toast,
  };

  if (authed === null) return <div className="splash" aria-busy="true" />;
  if (!authed) return <AppCtx.Provider value={ctx}><Login onDone={refreshMe} /></AppCtx.Provider>;

  const [, section, id] = hash.replace(/^#/, '').split('?')[0].split('/');
  let page;
  if (section === 'orders' && id) page = <OrderView id={Number(id)} />;
  else if (section === 'catalog') page = <Catalog />;
  else if (section === 'chats' && id) page = <ChatView id={Number(id)} />;
  else if (section === 'chats') page = <Chats />;
  else if (section === 'settings') page = <SettingsPage />;
  else page = <Orders />;

  const tabs: [string, Key, number?][] = [
    ['orders', 'tab_orders', me?.counts.to_prepare],
    ['chats', 'tab_chats', me?.counts.attention],
    ['catalog', 'tab_catalog'],
    ['settings', 'tab_settings'],
  ];

  return (
    <AppCtx.Provider value={ctx}>
      <div className="shell">
        <main className="page">{page}</main>
        <nav className="tabs" aria-label="Navigation">
          {tabs.map(([s, k, badge]) => (
            <a key={s} href={`#/${s}`} className={`tab${(section || 'orders') === s ? ' on' : ''}`}
               aria-current={(section || 'orders') === s ? 'page' : undefined}>
              <TabIcon name={s} />
              <span>{ctx.t(k)}</span>
              {badge ? <b className={`badge${s === 'chats' ? ' warn' : ''}`}>{badge}</b> : null}
            </a>
          ))}
        </nav>
        {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
      </div>
    </AppCtx.Provider>
  );
}

function TabIcon({ name }: { name: string }) {
  const p = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (name === 'orders') return <svg {...p}><path d="M6 3h12l1 4H5l1-4Z" /><path d="M5 7v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7" /><path d="M9 11h6" /></svg>;
  if (name === 'chats') return <svg {...p}><path d="M4 5h16v11H9l-5 4V5Z" /></svg>;
  if (name === 'catalog') return <svg {...p}><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></svg>;
  return <svg {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></svg>;
}

/** Shared helpers */
export function timeAgo(iso: string, lang: Lang) {
  const d = new Date(iso);
  return d.toLocaleString(lang === 'ar' ? 'ar-TN' : 'fr-TN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
