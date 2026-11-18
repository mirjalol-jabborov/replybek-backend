// The numbers of bookings the sidebar and Today show, counted in the database, so a screen that
// holds only a window of the bookings still shows them right. By a step's kind, as Today reads them.
import { stageIds } from "../shared/index.js";
import { dayOf } from "../shared/time.js";

/**
 * { pending: waiting for confirmation, any day (the sidebar); toConfirm: the same from today on;
 *   today: today's bookings that weren't called off; todayDone: those finished; todayEarned: what
 *   the finished ones cost; todayExpected: what today's cost, less no-shows }.
 * `staffId`: one specialist's only (ownOnly); `branchId`: one branch's.
 */
export async function bookingCounts(q, cfg, { staffId = null, branchId = null }) {
  const stages = cfg.data.apptStages;
  const mine = "($4::uuid IS NULL OR staff_id = $4) AND ($5::uuid IS NULL OR branch_id = $5)";
  const { rows } = await q(
    `SELECT (SELECT count(*)::int FROM crm_appointments WHERE workspace_id = $1 AND status = ANY($2::text[]) AND ${mine}) AS pending,
            (SELECT count(*)::int FROM crm_appointments WHERE workspace_id = $1 AND status = ANY($2::text[]) AND start_at >= $3::date AND ${mine}) AS "toConfirm",
            t.*
       FROM (SELECT count(*)::int AS today,
                    count(*) FILTER (WHERE status = ANY($7::text[]))::int AS "todayDone",
                    COALESCE(sum(price) FILTER (WHERE status = ANY($7::text[])), 0)::float8 AS "todayEarned",
                    COALESCE(sum(price) FILTER (WHERE status <> ALL($8::text[])), 0)::float8 AS "todayExpected"
               FROM crm_appointments
              WHERE workspace_id = $1 AND start_at >= $3::date AND start_at < $3::date + 1 AND status <> ALL($6::text[]) AND ${mine}) t`,
    [cfg.workspaceId, stageIds(stages, "pending"), dayOf(cfg.now), staffId, branchId, stageIds(stages, "cancelled"), stageIds(stages, "done"), stageIds(stages, "noshow")]
  );
  return rows[0];
}
