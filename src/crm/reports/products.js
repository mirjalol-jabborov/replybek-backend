// Products: what was sold in the span, what it brought in, its margin over cost and what came back.
// One query.
//
// Sold: the lines of orders handed over in the span (their goods left the shelf then). A line's
// income is quantity x price less its own discount, less its part of the order's discount (split by
// the lines' sums, whole soʻm, the rounding to the order's first line). The delivery fee is not a
// product's income. Margin: income less quantity x the variant's cost as it is now (orders don't
// keep the cost of the day). Returned: units that came back in the span (the ledger's `return` lines).
import { read, ONE, EACH } from "../db.js";
import { FROM, END } from "./money.js";
import { periodOf } from "./period.js";

/**
 * { products: [{ id, name, options, sold, income, margin, returned, variants: [{ id, values, sku, sold, income, margin, returned }] }] },
 * most income first. Only products with something sold or returned in the span.
 */
export function productsReport(workspaceId, input) {
  return read(workspaceId, async (q, cfg) => {
    const p = await periodOf(q, cfg, input);
    const { rows } = await q(
      `WITH handed AS (
         SELECT DISTINCT m.order_id FROM crm_stock_moves m
          WHERE m.workspace_id = $1 AND m.type = 'sale' AND m.order_id IS NOT NULL AND m.at >= ${FROM} AND m.at < ${END}
            AND ($5::uuid IS NULL OR m.branch_id = $5)
       ), lines AS (
         SELECT h.order_id, l.id, l.position, l.variant_id, l.qty, l.net, o.off
           FROM handed h
          CROSS JOIN LATERAL (SELECT o.discount::numeric AS off FROM crm_orders o WHERE o.workspace_id = $1 AND o.id = h.order_id ${ONE}) o
          CROSS JOIN LATERAL (SELECT l.id, l.position, l.variant_id, l.qty, (l.qty * l.price - l.discount)::numeric AS net
                                FROM crm_order_lines l WHERE l.workspace_id = $1 AND l.order_id = h.order_id ${EACH}) l
       ), split AS (
         SELECT *, sum(net) OVER w AS sub, row_number() OVER (w ORDER BY position, id) AS n FROM lines WINDOW w AS (PARTITION BY order_id)
       ), cut AS (
         SELECT *, least(off, sub) AS order_off, CASE WHEN sub > 0 THEN floor(least(off, sub) * net / sub) ELSE 0 END AS part FROM split
       ), priced AS (
         SELECT variant_id, qty, net - part - CASE WHEN n = 1 THEN order_off - sum(part) OVER (PARTITION BY order_id) ELSE 0 END AS income FROM cut
       ), sold AS (
         SELECT variant_id, sum(qty) AS qty, sum(income) AS income FROM priced GROUP BY variant_id
       ), back AS (
         SELECT m.variant_id, sum(m.qty) AS qty FROM crm_stock_moves m
          WHERE m.workspace_id = $1 AND m.type = 'return' AND m.at >= ${FROM} AND m.at < ${END} AND ($5::uuid IS NULL OR m.branch_id = $5)
          GROUP BY m.variant_id
       ), v AS (
         SELECT v.product_id, v.id, v.option_values AS values, v.sku, v.position, v.created_at,
                COALESCE(s.qty, 0) AS sold, COALESCE(s.income, 0) AS income, COALESCE(s.income, 0) - COALESCE(s.qty, 0) * v.cost AS margin,
                COALESCE(b.qty, 0) AS returned
           FROM (SELECT variant_id FROM sold UNION SELECT variant_id FROM back) x
           JOIN crm_variants v ON v.workspace_id = $1 AND v.id = x.variant_id
           LEFT JOIN sold s ON s.variant_id = x.variant_id LEFT JOIN back b ON b.variant_id = x.variant_id
       )
       SELECT pr.id, pr.name, pr.options, sum(v.sold)::float8 AS sold, sum(v.income)::float8 AS income, sum(v.margin)::float8 AS margin,
              sum(v.returned)::float8 AS returned,
              json_agg(json_build_object('id', v.id, 'values', v.values, 'sku', v.sku, 'sold', v.sold::float8, 'income', v.income::float8,
                                         'margin', v.margin::float8, 'returned', v.returned::float8) ORDER BY v.position, v.created_at, v.id) AS variants
         FROM v JOIN crm_products pr ON pr.workspace_id = $1 AND pr.id = v.product_id
        GROUP BY pr.id
        ORDER BY income DESC, sold DESC, pr.id`,
      [cfg.workspaceId, cfg.timezone, p.from, p.end, p.branch]
    );
    return { products: rows };
  });
}
