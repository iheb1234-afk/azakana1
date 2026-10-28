import type { Db } from '../db.js';
import type { CatalogVariant } from '../types.js';

export async function loadCatalog(db: Db, shopId: number): Promise<CatalogVariant[]> {
  const { rows } = await db.query(
    `SELECT v.id AS variant_id, p.name AS product, p.description, v.label,
            COALESCE(v.price_override, p.price) AS price, (v.stock_qty > 0) AS in_stock
       FROM variants v JOIN products p ON p.id = v.product_id
      WHERE p.shop_id = $1 AND p.active AND v.active
      ORDER BY p.name, v.id`,
    [shopId],
  );
  return rows;
}
