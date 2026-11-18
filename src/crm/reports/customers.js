// Customers: who was added, who came, who came back, who spent most, and the same by source and
// by tag. One query.
//
// added: customer records made in the span (the whole business; branches don't own customers).
// came: customers with a finished visit (a `done` step) or an order handed over in the span.
// returning: of those, the ones who had a finished visit or a handed-over order before the span.
// firstTime: came less returning.
// spend: what they paid in the span, counted as the income report counts it (finished paid visits,
//   money for handed-over orders, less refunds).
// bySource, byTag: the customers added, who came, or spent in the span, by the source and the tags
//   on their record now. A customer with two tags counts under both.
import { read, ONE } from "../db.js";
import { HANDED, TAKINGS, FROM, END, moneyParams } from "./money.js";
import { periodOf, apptSteps } from "./period.js";

export const TOP = 10;

export function customersReport(workspaceId, input) {
  return read(workspaceId, async (q, cfg) => {
    const p = await periodOf(q, cfg, input);
    // Every part reads the span, then looks customers up one by one (their earlier visits and orders
    // too), so the work follows the span, never the number of customers or the business's history.
    const { rows } = await q(
      `WITH ${HANDED}, ${TAKINGS},
       came AS (
         SELECT a.customer_id FROM crm_appointments a
          WHERE a.workspace_id = $1 AND a.start_at >= $3::date AND a.start_at < $4::date AND a.status = ANY($6::text[])
            AND ($5::uuid IS NULL OR a.branch_id = $5)
         UNION
         SELECT o.customer_id FROM crm_stock_moves m
          CROSS JOIN LATERAL (SELECT o.customer_id, o.branch_id FROM crm_orders o WHERE o.workspace_id = $1 AND o.id = m.order_id ${ONE}) o
          WHERE m.workspace_id = $1 AND m.type = 'sale' AND m.order_id IS NOT NULL AND m.at >= ${FROM} AND m.at < ${END}
            AND ($5::uuid IS NULL OR o.branch_id = $5)
       ), back AS (
         SELECT k.customer_id FROM came k
          CROSS JOIN LATERAL (SELECT 1 FROM crm_appointments a WHERE a.workspace_id = $1 AND a.customer_id = k.customer_id
                                 AND a.status = ANY($6::text[]) AND a.start_at < $3::date ${ONE}) x
         UNION
         SELECT k.customer_id FROM came k
          CROSS JOIN LATERAL (SELECT 1 FROM crm_orders o JOIN crm_stock_moves m ON m.workspace_id = $1 AND m.order_id = o.id AND m.type = 'sale'
                               WHERE o.workspace_id = $1 AND o.customer_id = k.customer_id AND m.order_id IS NOT NULL AND m.at < ${FROM} ${ONE}) x
       ), spend AS (
         SELECT customer_id, sum(CASE WHEN what = 'refund' THEN -amount ELSE amount END) AS spend FROM takings GROUP BY customer_id
       ), added AS (
         SELECT id FROM crm_customers WHERE workspace_id = $1 AND created_at >= ${FROM} AND created_at < ${END}
       ), seen AS (
         SELECT x.id, c.name, c.phone, c.source, c.tags, a.id IS NOT NULL AS added, k.customer_id IS NOT NULL AS came, COALESCE(s.spend, 0) AS spend
           FROM (SELECT id FROM added UNION SELECT customer_id FROM came UNION SELECT customer_id FROM spend) x
          CROSS JOIN LATERAL (SELECT c.name, c.phone, c.source, c.tags FROM crm_customers c WHERE c.workspace_id = $1 AND c.id = x.id ${ONE}) c
           LEFT JOIN added a ON a.id = x.id LEFT JOIN came k ON k.customer_id = x.id LEFT JOIN spend s ON s.customer_id = x.id
       )
       SELECT (SELECT count(*)::int FROM added) AS added,
              (SELECT count(*)::int FROM came) AS came,
              (SELECT count(*)::int FROM back) AS returning,
              (SELECT COALESCE(json_agg(json_build_object('id', t.id, 'name', t.name, 'phone', t.phone, 'spend', t.spend::float8) ORDER BY t.spend DESC, t.name, t.id), '[]')
                 FROM (SELECT * FROM seen WHERE spend > 0 ORDER BY spend DESC, name, id LIMIT ${TOP}) t) AS top,
              (SELECT COALESCE(json_agg(x ORDER BY x.spend DESC, x.source), '[]') FROM
                 (SELECT source, count(*) FILTER (WHERE added)::int AS added, count(*) FILTER (WHERE came)::int AS came, sum(spend)::float8 AS spend
                    FROM seen GROUP BY source) x) AS "bySource",
              (SELECT COALESCE(json_agg(x ORDER BY x.spend DESC, x.tag), '[]') FROM
                 (SELECT tag, count(*) FILTER (WHERE added)::int AS added, count(*) FILTER (WHERE came)::int AS came, sum(spend)::float8 AS spend
                    FROM seen CROSS JOIN unnest(tags) AS tag GROUP BY tag) x) AS "byTag"`,
      moneyParams(cfg, p, apptSteps(cfg, "done"))
    );
    const r = rows[0];
    return { added: r.added, came: r.came, returning: r.returning, firstTime: r.came - r.returning, top: r.top, bySource: r.bySource, byTag: r.byTag };
  });
}
