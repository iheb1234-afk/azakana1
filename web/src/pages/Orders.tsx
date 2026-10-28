import { useEffect, useState } from 'react';
import { api, dt, type OrderRow, type Status } from '../api';
import { timeAgo, useApp } from '../App';
import type { Key } from '../i18n';

const FILTERS: (Status | 'all')[] = ['confirmed', 'shipped', 'delivered', 'awaiting_confirmation', 'all'];
const TRACK: Status[] = ['confirmed', 'shipped', 'delivered'];

/** The order's journey: confirmed → shipped → delivered. Cancelled/returned shows where it stopped. */
export function Track({ status }: { status: Status }) {
  const { t } = useApp();
  const stopped = status === 'cancelled' || status === 'returned';
  const reached = status === 'returned' ? 2 : TRACK.indexOf(status);
  return (
    <ol className={`track${stopped ? ' stopped' : ''}`} aria-label={t(`st_${status}` as Key)}>
      {TRACK.map((s, i) => (
        <li key={s} className={i <= reached && !(status === 'cancelled') ? 'done' : ''}>
          <span className="dot" />
          <span className="lbl">{t(`st_${s}` as Key)}</span>
        </li>
      ))}
    </ol>
  );
}

export function Orders() {
  const { t, me, lang } = useApp();
  const [filter, setFilter] = useState<Status | 'all'>('confirmed');
  const [rows, setRows] = useState<OrderRow[] | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => api.get<OrderRow[]>(`/orders${filter === 'all' ? '' : `?status=${filter}`}`).then((r) => live && setRows(r)).catch(() => {});
    load();
    const i = setInterval(load, 15_000);
    return () => { live = false; clearInterval(i); };
  }, [filter]);

  return (
    <>
      <header className="top">
        <h1>{me?.shop.name}</h1>
        <div className="counters">
          <a href="#/orders" className="counter"><strong>{me?.counts.to_prepare ?? '–'}</strong><span>{t('to_prepare')}</span></a>
          <span className="counter"><strong>{me?.counts.today ?? '–'}</strong><span>{t('today')}</span></span>
          <a href="#/chats" className={`counter${me?.counts.attention ? ' warn' : ''}`}><strong>{me?.counts.attention ?? '–'}</strong><span>{t('attention')}</span></a>
        </div>
      </header>

      <div className="chips" role="tablist">
        {FILTERS.map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} className={`chip${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>
            {t(`st_${f}` as Key)}
          </button>
        ))}
      </div>

      {rows === null ? <div className="skeleton" /> : rows.length === 0 ? (
        <p className="empty">{t('no_orders')}</p>
      ) : (
        <ul className="list">
          {rows.map((o) => (
            <li key={o.id}>
              <a className="order" href={`#/orders/${o.id}`}>
                <div className="order-head">
                  <span className="order-id" dir="ltr">#{o.id}</span>
                  <span className="order-name" dir="auto">{o.customer_name}</span>
                  <span className="order-total" dir="ltr">{dt(o.total)}</span>
                </div>
                <p className="order-items" dir="auto">{o.summary}</p>
                <p className="order-meta">
                  <span dir="auto">{o.address}</span>
                  <span>{timeAgo(o.confirmed_at ?? o.created_at, lang)}</span>
                </p>
                {o.status === 'awaiting_confirmation' ? <span className="pill">{t('st_awaiting_confirmation')}</span> : <Track status={o.status} />}
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
