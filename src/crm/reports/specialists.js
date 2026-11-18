// Specialists: their finished visits, what those brought in, and how much of their working time
// was booked. One query; the working time is worked out in SQL with time ranges.
//
// Working time: each day of the span, the specialist's hours for that weekday, less their breaks,
// less time off (their own and the whole branch's). Only for specialists switched on.
// Booked time: the part of that working time covered by their bookings that keep their time (every
// kind of step except noshow and cancelled), so a visit booked outside the hours doesn't count and
// the share never passes 1.
import { APPT_KINDS } from "../shared/index.js";
import { kindHolds } from "../shared/booking-steps.js";
import { read } from "../db.js";
import { periodOf, apptSteps, share } from "./period.js";

/** The kinds of step whose bookings keep their time. */
const HOLDING = APPT_KINDS.map((k) => k.value).filter(kindHolds);
const MINUTES = (mr) => `COALESCE((SELECT sum(extract(epoch FROM upper(x) - lower(x))) FROM unnest(${mr}) AS x) / 60, 0)::int`;

/**
 * { specialists: [{ id, name, active, visits, paid, income, workMinutes, bookedMinutes, bookedShare }] },
 * in the team's order. visits: finished visits; income: their prices when paid; bookedShare:
 * bookedMinutes / workMinutes (null without working time).
 */
export function specialistsReport(workspaceId, input) {
  return read(workspaceId, async (q, cfg) => {
    const p = await periodOf(q, cfg, input);
    const { rows } = await q(
      `WITH staff AS (
         SELECT s.id, s.name, s.active, s.hours, s.breaks, s.branch_id, s.created_at FROM crm_staff s
          WHERE s.workspace_id = $1 AND ($4::uuid IS NULL OR s.branch_id = $4)
       ), work AS (
         SELECT s.id AS staff_id, d.day, s.hours -> extract(dow FROM d.day)::int::text AS h
           FROM staff s CROSS JOIN generate_series($2::date::timestamp, ($3::date - 1)::timestamp, interval '1 day') AS d(day)
          WHERE s.active AND jsonb_typeof(s.hours -> extract(dow FROM d.day)::int::text) = 'array'
       ), hours AS (
         SELECT staff_id, range_agg(tsrange(day + (h ->> 0)::interval, day + (h ->> 1)::interval)) AS mr FROM work
          WHERE (h ->> 0) < (h ->> 1) GROUP BY staff_id
       ), breaks AS (
         SELECT w.staff_id, range_agg(tsrange(w.day + (b ->> 'from')::interval, w.day + (b ->> 'to')::interval)) AS mr
           FROM work w JOIN staff s ON s.id = w.staff_id CROSS JOIN jsonb_array_elements(s.breaks) AS b
          WHERE (b ->> 'from') < (b ->> 'to')
          GROUP BY w.staff_id
       ), away AS (
         SELECT s.id AS staff_id, range_agg(tsrange(t.start_at, t.end_at + interval '1 minute')) AS mr
           FROM crm_time_off t JOIN staff s ON t.staff_id = s.id OR (t.staff_id IS NULL AND t.branch_id = s.branch_id)
          WHERE t.workspace_id = $1 AND t.end_at >= $2::date AND t.start_at < $3::date
          GROUP BY s.id
       ), free AS (
         SELECT h.staff_id, h.mr - COALESCE(b.mr, '{}'::tsmultirange) - COALESCE(a.mr, '{}'::tsmultirange) AS mr
           FROM hours h LEFT JOIN breaks b USING (staff_id) LEFT JOIN away a USING (staff_id)
       ), visits AS (
         SELECT a.staff_id, count(*) FILTER (WHERE a.status = ANY($5::text[]))::int AS visits,
                count(*) FILTER (WHERE a.status = ANY($5::text[]) AND a.paid)::int AS paid,
                COALESCE(sum(a.price) FILTER (WHERE a.status = ANY($5::text[]) AND a.paid), 0)::float8 AS income,
                range_agg(tsrange(a.start_at, a.start_at + make_interval(mins => a.duration))) FILTER (WHERE a.status = ANY($6::text[])) AS booked
           FROM crm_appointments a
          WHERE a.workspace_id = $1 AND a.start_at >= $2::date AND a.start_at < $3::date AND ($4::uuid IS NULL OR a.branch_id = $4)
          GROUP BY a.staff_id
       )
       SELECT s.id, s.name, s.active, COALESCE(v.visits, 0) AS visits, COALESCE(v.paid, 0) AS paid, COALESCE(v.income, 0) AS income,
              ${MINUTES("f.mr")} AS "workMinutes", ${MINUTES("v.booked * f.mr")} AS "bookedMinutes"
         FROM staff s LEFT JOIN free f ON f.staff_id = s.id LEFT JOIN visits v ON v.staff_id = s.id
        ORDER BY s.created_at, s.id`,
      [cfg.workspaceId, p.from, p.end, p.branch, apptSteps(cfg, "done"), apptSteps(cfg, ...HOLDING)]
    );
    return { specialists: rows.map((r) => ({ ...r, bookedShare: share(r.bookedMinutes, r.workMinutes) })) };
  });
}
