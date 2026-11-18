// Stock: what the shelf is worth now, what is running low now, and what sat still in the span.
// One query.
//
// value: units on hand x the variant's cost, every variant (one put away too, while goods are on its shelf).
// low: variants in use whose available stock (on hand less held for orders) is at or below their
//   low mark (shared isLow; a mark of 0 means out of stock).
// still: variants with goods on hand and no goods movement in the span (receipts, sales, write-offs,
//   returns, counts; holding goods for an order is not a movement).
// Both lists are capped at LIST, their counts are not.
import { read } from "../db.js";
import { FROM, END } from "./money.js";
import { periodOf } from "./period.js";

export const LIST = 200;

const ITEM = `json_build_object('id', i.id, 'productId', i.product_id, 'name', i.name, 'options', i.options, 'values', i.values, 'sku', i.sku,
  'onSale', i.on_sale, 'stock', i.on_hand::float8, 'reserved', i.reserved::float8, 'lowAt', i.low_at, 'cost', i.cost::float8, 'value', (i.on_hand * i.cost)::float8)`;

/** { value, units, low: { count, items }, still: { count, items } }. An item: { id, productId, name, options, values, sku, onSale, stock, reserved, lowAt, cost, value }. */
export function stockReport(workspaceId, input) {
  return read(workspaceId, async (q, cfg) => {
    const p = await periodOf(q, cfg, input);
    const { rows } = await q(
      `WITH s AS (
         SELECT variant_id, sum(on_hand) AS on_hand, sum(reserved) AS reserved FROM crm_stock
          WHERE workspace_id = $1 AND ($5::uuid IS NULL OR branch_id = $5) GROUP BY variant_id
       ), moved AS (
         SELECT DISTINCT variant_id FROM crm_stock_moves
          WHERE workspace_id = $1 AND type NOT IN ('reserve', 'release') AND at >= ${FROM} AND at < ${END} AND ($5::uuid IS NULL OR branch_id = $5)
       ), i AS (
         SELECT v.id, v.product_id, p.name, p.options, v.option_values AS values, v.sku, p.on_sale, v.cost, v.low_at, v.archived,
                COALESCE(s.on_hand, 0) AS on_hand, COALESCE(s.reserved, 0) AS reserved, m.variant_id IS NOT NULL AS moved
           FROM crm_variants v JOIN crm_products p ON p.workspace_id = $1 AND p.id = v.product_id
           LEFT JOIN s ON s.variant_id = v.id LEFT JOIN moved m ON m.variant_id = v.id
          WHERE v.workspace_id = $1
       )
       SELECT (SELECT COALESCE(sum(on_hand * cost), 0)::float8 FROM i) AS value,
              (SELECT COALESCE(sum(on_hand), 0)::float8 FROM i) AS units,
              (SELECT count(*)::int FROM i WHERE NOT archived AND on_hand - reserved <= low_at) AS low_count,
              (SELECT COALESCE(json_agg(${ITEM} ORDER BY i.on_hand - i.reserved, i.name, i.id), '[]') FROM
                 (SELECT * FROM i WHERE NOT archived AND on_hand - reserved <= low_at ORDER BY on_hand - reserved, name, id LIMIT ${LIST}) i) AS low,
              (SELECT count(*)::int FROM i WHERE on_hand > 0 AND NOT moved) AS still_count,
              (SELECT COALESCE(json_agg(${ITEM} ORDER BY i.on_hand * i.cost DESC, i.name, i.id), '[]') FROM
                 (SELECT * FROM i WHERE on_hand > 0 AND NOT moved ORDER BY on_hand * cost DESC, name, id LIMIT ${LIST}) i) AS still`,
      [cfg.workspaceId, cfg.timezone, p.from, p.end, p.branch]
    );
    const r = rows[0];
    return { value: r.value, units: r.units, low: { count: r.low_count, items: r.low }, still: { count: r.still_count, items: r.still } };
  });
}
