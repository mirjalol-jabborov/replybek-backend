// Bookings by what happened to them: how many of the visits planned in the span (by their start)
// are in a step of each kind now, and what share of the visits that came due were missed. One query.
import { APPT_KINDS } from "../shared/index.js";
import { read } from "../db.js";
import { periodOf, apptKinds, share } from "./period.js";

/**
 * { total, byKind: { pending, booked, here, done, noshow, cancelled }: { count, value }, noShowRate }.
 * `value` is the bookings' prices. noShowRate = noshow / (done + noshow): of the visits that were
 * finished or missed, the share missed; null when there were none.
 */
export function bookingsReport(workspaceId, input) {
  return read(workspaceId, async (q, cfg) => {
    const p = await periodOf(q, cfg, input);
    const { rows } = await q(
      `SELECT GROUPING(k.kind) = 1 AS total, k.kind, count(*)::int AS count, COALESCE(sum(a.price), 0)::float8 AS value
         FROM crm_appointments a LEFT JOIN jsonb_each_text($5::jsonb) AS k(id, kind) ON k.id = a.status
        WHERE a.workspace_id = $1 AND a.start_at >= $2::date AND a.start_at < $3::date AND ($4::uuid IS NULL OR a.branch_id = $4)
        GROUP BY ROLLUP (k.kind)`,
      [cfg.workspaceId, p.from, p.end, p.branch, apptKinds(cfg)]
    );
    const byKind = Object.fromEntries(APPT_KINDS.map((k) => [k.value, { count: 0, value: 0 }]));
    for (const r of rows) if (!r.total && byKind[r.kind]) byKind[r.kind] = { count: r.count, value: r.value };
    const total = rows.find((r) => r.total)?.count || 0;
    return { total, byKind, noShowRate: share(byKind.noshow.count, byKind.done.count + byKind.noshow.count) };
  });
}
