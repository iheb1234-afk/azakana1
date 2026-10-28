import { useEffect, useState } from 'react';
import { api, dt, type Product, type Variant } from '../api';
import { useApp } from '../App';

interface DraftVariant { label: string; price_override: string; stock_qty: string }
const emptyVariant = (): DraftVariant => ({ label: '', price_override: '', stock_qty: '1' });

export function Catalog() {
  const { t, toast } = useApp();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [adding, setAdding] = useState(false);
  const load = () => api.get<Product[]>('/products').then(setProducts).catch(() => toast(t('err_generic')));
  useEffect(() => { load(); }, []);

  async function bump(v: Variant, delta: number) {
    // optimistic: the button feels instant, the server keeps it >= 0
    setProducts((ps) => ps!.map((p) => ({ ...p, variants: p.variants.map((x) => x.id === v.id ? { ...x, stock_qty: Math.max(0, x.stock_qty + delta) } : x) })));
    try { await api.post(`/variants/${v.id}/stock`, { delta }); } catch { toast(t('err_generic')); load(); }
  }
  async function toggle(p: Product) {
    try { await api.patch(`/products/${p.id}`, { active: !p.active }); load(); } catch { toast(t('err_generic')); }
  }

  return (
    <>
      <header className="sub">
        <h1>{t('tab_catalog')}</h1>
        {!adding && <button className="btn primary" onClick={() => setAdding(true)}>{t('add_product')}</button>}
      </header>

      {adding && <AddProduct onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); toast(t('saved')); }} />}

      {products === null ? <div className="skeleton" /> : products.length === 0 && !adding ? (
        <p className="empty">{t('no_products')}</p>
      ) : (
        <ul className="list">
          {products.map((p) => (
            <li key={p.id} className={`product${p.active ? '' : ' off'}`}>
              <div className="product-head">
                <div>
                  <h2>{p.name}</h2>
                  {p.description && <p className="muted">{p.description}</p>}
                </div>
                <span className="product-price" dir="ltr">{dt(p.price)}</span>
              </div>
              <ul className="variants">
                {p.variants.map((v) => (
                  <li key={v.id} className={v.stock_qty === 0 ? 'empty-stock' : ''}>
                    <span className="v-label">{v.label}</span>
                    <span className="v-price" dir="ltr">{v.price_override != null ? dt(v.price_override) : ''}</span>
                    {v.stock_qty === 0 && <span className="pill danger">{t('out_of_stock')}</span>}
                    <div className="stepper" dir="ltr">
                      <button aria-label="-1" onClick={() => bump(v, -1)} disabled={v.stock_qty === 0}>−</button>
                      <output aria-label={t('stock')}>{v.stock_qty}</output>
                      <button aria-label="+1" onClick={() => bump(v, 1)}>+</button>
                    </div>
                  </li>
                ))}
              </ul>
              <button className="link-btn" onClick={() => toggle(p)}>{p.active ? t('hide') : `${t('hidden')} · ${t('show')}`}</button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function AddProduct({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t, toast } = useApp();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [variants, setVariants] = useState<DraftVariant[]>([emptyVariant()]);
  const [busy, setBusy] = useState(false);

  const setV = (i: number, k: keyof DraftVariant, val: string) =>
    setVariants((vs) => vs.map((v, j) => (j === i ? { ...v, [k]: val } : v)));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/products', {
        name, description, price: Number(price.replace(',', '.')),
        variants: variants.filter((v) => v.label.trim()).map((v) => ({
          label: v.label, price_override: v.price_override ? Number(v.price_override.replace(',', '.')) : null, stock_qty: Number(v.stock_qty) || 0,
        })),
      });
      onSaved();
    } catch { toast(t('err_generic')); } finally { setBusy(false); }
  }

  return (
    <form className="panel form" onSubmit={save}>
      <label className="field"><span>{t('product_name')}</span><input value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></label>
      <label className="field"><span>{t('price')}</span><input inputMode="decimal" dir="ltr" value={price} onChange={(e) => setPrice(e.target.value)} required /></label>
      <label className="field"><span>{t('description')}</span><input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <fieldset>
        <legend>{t('variants')}</legend>
        {variants.map((v, i) => (
          <div className="variant-row" key={i}>
            <input aria-label={t('variant_label')} placeholder={t('variant_label')} value={v.label} onChange={(e) => setV(i, 'label', e.target.value)} />
            <input aria-label={t('variant_price')} placeholder={t('variant_price')} inputMode="decimal" dir="ltr" value={v.price_override} onChange={(e) => setV(i, 'price_override', e.target.value)} />
            <input aria-label={t('stock')} placeholder={t('stock')} inputMode="numeric" dir="ltr" value={v.stock_qty} onChange={(e) => setV(i, 'stock_qty', e.target.value)} />
          </div>
        ))}
        <button type="button" className="link-btn" onClick={() => setVariants((vs) => [...vs, emptyVariant()])}>{t('add_variant')}</button>
      </fieldset>
      <div className="actions">
        <button className="btn primary" disabled={busy}>{t('save_product')}</button>
        <button type="button" className="btn ghost" onClick={onClose}>{t('cancel')}</button>
      </div>
    </form>
  );
}
