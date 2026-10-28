import { useEffect, useRef, useState } from 'react';
import { api, type ConvDetail } from '../api';
import { timeAgo, useApp } from '../App';

export function ChatView({ id }: { id: number }) {
  const { t, lang, toast, refreshMe } = useApp();
  const [c, setC] = useState<ConvDetail | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  const load = () => api.get<ConvDetail>(`/conversations/${id}`).then(setC).catch(() => toast(t('err_generic')));
  useEffect(() => {
    load();
    api.post(`/conversations/${id}/seen`).then(refreshMe).catch(() => {});
    const i = setInterval(load, 5_000);
    return () => clearInterval(i);
  }, [id]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [c?.messages.length]);

  async function toggleBot() {
    if (!c) return;
    setBusy(true);
    try { await api.post(`/conversations/${id}/${c.bot_paused ? 'release' : 'takeover'}`); await load(); refreshMe(); }
    catch { toast(t('err_generic')); } finally { setBusy(false); }
  }
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      const r = await api.post<{ delivered: boolean }>(`/conversations/${id}/reply`, { text });
      setText('');
      if (!r.delivered) toast(t('not_delivered'));
      await load();
    } catch { toast(t('err_generic')); } finally { setBusy(false); }
  }

  if (!c) return <div className="skeleton" />;
  return (
    <div className="chat">
      <header className="sub chat-head">
        <a href="#/chats" className="back">{t('back')}</a>
        <h1 dir="auto">{c.customer_name ?? `${t('customer')} ${c.customer_id.slice(-4)}`}</h1>
        <button className={`toggle${c.bot_paused ? ' you' : ''}`} onClick={toggleBot} disabled={busy} aria-pressed={c.bot_paused}>
          <span className="knob" />
          <span>{c.bot_paused ? t('give_back') : t('take_over')}</span>
        </button>
      </header>
      <p className={`mode${c.bot_paused ? ' you' : ''}`}>{c.bot_paused ? t('bot_off') : t('bot_on')}</p>

      <div className="thread">
        {c.messages.map((m) => (
          <div key={m.id} className={`bubble ${m.direction === 'in' ? 'them' : m.sent_by === 'owner' ? 'me' : 'bot'}`}>
            {m.direction === 'out' && <span className="who">{m.sent_by === 'owner' ? t('from_owner') : t('from_bot')}</span>}
            <p dir="auto">{m.text ?? `[${t('photo')}]`}</p>
            {m.media_url && m.text && <p className="muted">[{t('photo')}]</p>}
            <time>{timeAgo(m.created_at, lang)}{m.direction === 'out' && m.status !== 'done' ? ` · ${t('not_delivered')}` : ''}</time>
          </div>
        ))}
        <div ref={end} className="thread-end" />
      </div>

      <form className="composer" onSubmit={send}>
        <textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('write')} aria-label={t('write')} />
        <button className="btn primary" disabled={busy || !text.trim()}>{t('send')}</button>
      </form>
      <p className="hint">{t('reply_window')}</p>
    </div>
  );
}
