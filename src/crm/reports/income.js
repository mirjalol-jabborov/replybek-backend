// Income over time: one row per day, week or month of the span, every row there even when it is
// empty (a chart shows the gaps), and the whole span's total. One query.
import { read } from "../db.js";
import { HANDED, TAKINGS, moneyParams } from "./money.js";
import { periodOf, apptSteps } from "./period.js";

const SUMS = `
  COALESCE(sum(t.amount) FILTER (WHERE t.what = 'booking'), 0)::float8 AS bookings,
  COALESCE(sum(t.amount) FILTER (WHERE t.what = 'order'), 0)::float8 AS orders,
  COALESCE(sum(t.amount) FILTER (WHERE t.what = 'refund'), 0)::float8 AS refunds`;

/**
 * { by, rows: [{ start, end, bookings, orders, refunds, net }], total: { bookings, orders, refunds, net } }.
 * A row's start and end are days inside the span: the first week or month may begin after its
 * Monday or its 1st, the last may end before its Sunday or its last day.
 */
export function incomeReport(workspaceId, input) {
  return read(workspaceId, async (q, cfg) => {
    const p = await periodOf(q, cfg, input);
    const { rows } = await q(
      `WITH ${HANDED}, ${TAKINGS},
       buckets AS (
         SELECT g::date AS start FROM generate_series(date_trunc($7, $3::date::timestamp), ($4::date - 1)::timestamp, ('1 ' || $7)::interval) g
       )
       SELECT GROUPING(b.start) = 1 AS total,
              to_char(greatest(b.start, $3::date), 'YYYY-MM-DD') AS start,
              to_char(least((b.start + ('1 ' || $7)::interval)::date - 1, $4::date - 1), 'YYYY-MM-DD') AS "end",
              ${SUMS}
         FROM buckets b LEFT JOIN takings t ON date_trunc($7, t.at)::date = b.start
        GROUP BY ROLLUP (b.start)
        ORDER BY GROUPING(b.start), b.start`,
      [...moneyParams(cfg, p, apptSteps(cfg, "done")), input.by]
    );
    const money = (r) => ({ bookings: r.bookings, orders: r.orders, refunds: r.refunds, net: r.bookings + r.orders - r.refunds });
    const total = rows.find((r) => r.total);
    return { by: input.by, rows: rows.filter((r) => !r.total).map((r) => ({ start: r.start, end: r.end, ...money(r) })), total: money(total) };
  });
}
