// Services: how often each was done in the span and what it brought in. One query.
//
// A visit can hold several services but has one price. Its price is split between them by their
// list prices now (evenly when they are all free or gone), in whole soʻm, the rest of the
// rounding going to the visit's first service. So the services' income adds up to exactly the
// income of finished, paid visits in the income report.
import { read } from "../db.js";
import { periodOf, apptSteps, average } from "./period.js";

/**
 * { services: [{ id, name, category, visits, paid, income, average }] }, most income first.
 * visits: finished visits that included it; paid: those of them paid; income: its part of the paid
 * ones' prices; average: income / paid. `name` is null for a service that was deleted since.
 */
export function servicesReport(workspaceId, input) {
  return read(workspaceId, async (q, cfg) => {
    const p = await periodOf(q, cfg, input);
    const { rows } = await q(
      `WITH a AS (
         SELECT a.id, a.price, a.paid, a.service_ids FROM crm_appointments a
          WHERE a.workspace_id = $1 AND a.start_at >= $2::date AND a.start_at < $3::date AND a.status = ANY($5::text[])
            AND ($4::uuid IS NULL OR a.branch_id = $4)
       ), parts AS (
         SELECT a.id, a.price, a.paid, u.service_id, u.n, COALESCE(s.price, 0)::numeric AS weight,
                sum(COALESCE(s.price, 0)) OVER (PARTITION BY a.id)::numeric AS weights, count(*) OVER (PARTITION BY a.id) AS k
           FROM a CROSS JOIN LATERAL unnest(a.service_ids) WITH ORDINALITY AS u(service_id, n)
           LEFT JOIN crm_services s ON s.workspace_id = $1 AND s.id = u.service_id
       ), cut AS (
         SELECT *, CASE WHEN weights > 0 THEN floor(price * weight / weights) ELSE floor(price::numeric / k) END AS part FROM parts
       ), shares AS (
         SELECT service_id, paid, part + CASE WHEN n = 1 THEN price - sum(part) OVER (PARTITION BY id) ELSE 0 END AS part FROM cut
       )
       SELECT x.service_id AS id, s.name, s.category, count(*)::int AS visits, count(*) FILTER (WHERE x.paid)::int AS paid,
              COALESCE(sum(x.part) FILTER (WHERE x.paid), 0)::float8 AS income
         FROM shares x LEFT JOIN crm_services s ON s.workspace_id = $1 AND s.id = x.service_id
        GROUP BY x.service_id, s.name, s.category
        ORDER BY income DESC, visits DESC, x.service_id`,
      [cfg.workspaceId, p.from, p.end, p.branch, apptSteps(cfg, "done")]
    );
    return { services: rows.map((r) => ({ ...r, category: r.category ?? "", average: average(r.income, r.paid) })) };
  });
}
