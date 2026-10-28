import { useEffect, useState } from 'react';
import { api, dt, type OrderDetail, type Status } from '../api';
import { timeAgo, useApp } from '../App';
import type { Key } from '../i18n';
import { Track } from './Orders';

const NEXT: Record<string, Status[]> = {
  awaiting_confirmation: ['cancelled'],
  confirmed: ['shipped', 'cancelled'],
  shipped: ['delivered', 'returned'],
  delivered: ['returned'],
};

export function OrderView({ id }: { id: number }) {
  const { t, lang, toast, refreshMe } = useApp();
  const [o, setO] = useState<OrderDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get<OrderDetail>(`/orders/${id}`).then(setO).catch(() => toast(t('err_generic')));
  useEffect(() => { load(); }, [id]);

  async function move(s: Status) {
    if ((s === 'cancelled' || s === 'returned') && !confirm(t('confirm_cancel'))) return;
    setBusy(true);
    try {
      await api.post(`/orders/${id}/status`, { status: s });
      toast(t(`st_${s}` as Key));
      await load();
      refreshMe();
    } catch { toast(t('err_generic')); } finally { setBusy(false); }
  }

  if (!o) return <div className="skeleton" />;
  const subtotal = o.items.reduce((s, i) => s + i.qty * i.unit_price, 0);

  return (
    <>
      <header className="sub">
        <a href="#/orders" className="back">{t('back')}</a>
        <h1><span dir="ltr">#{o.id}</span> {o.customer_name}</h1>
      </header>

      <section className="panel">
        {o.status === 'awaiting_confirmation' ? <span className="pill">{t('st_awaiting_confirmation')}</span> : <Track status={o.status} />}
        <div className="actions">
          {(NEXT[o.status] ?? []).map((s) => (
            <button key={s} disabled={busy} className={`btn ${s === 'cancelled' || s === 'returned' ? 'ghost danger' : 'primary'}`} onClick={() => move(s)}>
              {t(`act_${s}` as Key)}
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <p className="big-phone" dir="ltr">{o.phone}</p>
        <p dir="auto">{o.address}</p>
        <div className="actions">
          <a className="btn ghost" href={`tel:+216${o.phone}`}>{t('call')}</a>
          <a className="btn ghost" href={`https://wa.me/216${o.phone}`} target="_blank" rel="noreferrer">{t('whatsapp')}</a>
          <a className="btn ghost" href={`#/chats/${o.conversation_id}`}>{t('open_chat')}</a>
        </div>
      </section>

      <section className="panel">
        <h2>{t('items')}</h2>
        <table className="lines">
          <tbody>
            {o.items.map((i, k) => (
              <tr key={k}><td dir="auto">{i.qty} × {i.name} {i.label}</td><td dir="ltr">{dt(i.qty * i.unit_price)}</td></tr>
            ))}
            {o.delivery_fee > 0 && <tr><td>{t('delivery')}</td><td dir="ltr">{dt(o.delivery_fee)}</td></tr>}
            <tr className="sum"><td>{t('total')}</td><td dir="ltr">{dt(subtotal + o.delivery_fee)}</td></tr>
          </tbody>
        </table>
      </section>

      {o.events.length > 0 && (
        <section className="panel">
          <h2>{t('history')}</h2>
          <ul className="events">
            {o.confirmed_at && <li><span>{t('st_confirmed')}</span><time>{timeAgo(o.confirmed_at, lang)}</time></li>}
            {o.events.map((e, k) => <li key={k}><span>{t(`st_${e.status}` as Key)}</span><time>{timeAgo(e.created_at, lang)}</time></li>)}
          </ul>
        </section>
      )}
    </>
  );
}
