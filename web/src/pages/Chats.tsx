import { useEffect, useState } from 'react';
import { api, type ConvRow } from '../api';
import { timeAgo, useApp } from '../App';

export function Chats() {
  const { t, lang } = useApp();
  const [filter, setFilter] = useState<'attention' | 'all'>('attention');
  const [rows, setRows] = useState<ConvRow[] | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => api.get<ConvRow[]>(`/conversations?filter=${filter}`).then((r) => live && setRows(r)).catch(() => {});
    load();
    const i = setInterval(load, 10_000);
    return () => { live = false; clearInterval(i); };
  }, [filter]);

  return (
    <>
      <header className="sub"><h1>{t('tab_chats')}</h1></header>
      <div className="chips" role="tablist">
        {(['attention', 'all'] as const).map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} className={`chip${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>
            {t(f === 'attention' ? 'chats_attention' : 'chats_all')}
          </button>
        ))}
      </div>
      {rows === null ? <div className="skeleton" /> : rows.length === 0 ? <p className="empty">{t('no_chats')}</p> : (
        <ul className="list">
          {rows.map((c) => (
            <li key={c.id}>
              <a className={`chat-row${c.needs_attention ? ' flag' : ''}`} href={`#/chats/${c.id}`}>
                <span className={`ch ch-${c.channel}`} aria-label={c.channel}>{c.channel === 'facebook' ? 'f' : c.channel === 'instagram' ? 'ig' : c.channel.slice(0, 2)}</span>
                <div className="chat-main">
                  <div className="chat-top">
                    <strong dir="auto">{c.customer_name ?? `${t('customer')} ${c.customer_id.slice(-4)}`}</strong>
                    <time>{timeAgo(c.last_message_at, lang)}</time>
                  </div>
                  <p className="chat-last" dir="auto">{c.last_text ?? `[${t('photo')}]`}</p>
                  <span className={`pill${c.bot_paused ? ' you' : ''}`}>{c.bot_paused ? t('bot_off') : t('bot_on')}</span>
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
