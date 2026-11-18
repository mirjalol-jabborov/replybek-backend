// The numbers of orders the sidebar and Today show, counted in the database, so a screen that holds
// only a window of the orders still shows them right. By a step's kind, as Today reads them.
import { stageIds } from "../shared/index.js";
import { dayOf } from "../shared/time.js";
import { listOrders } from "./rows.js";

/**
 * { open: not accepted yet (the sidebar, Today's "New orders"); reserved: accepted, goods held;
 *   toDeliver: reserved with a delivery day of today or earlier (or an empty one); soldToday: the totals of
 *   finished orders delivered today }. `branchId`: one branch's.
 */
export async function orderCounts(q, cfg, branchId) {
  const stages = cfg.data.orderStages;
  const today = dayOf(cfg.now);
  const { rows } = await q(
    `SELECT count(*) FILTER (WHERE status = ANY($2::text[]))::int AS open,
            count(*) FILTER (WHERE status = ANY($3::text[]))::int AS reserved,
            count(*) FILTER (WHERE status = ANY($3::text[]) AND delivery->>'date' <= $4)::int AS "toDeliver"
       FROM crm_orders WHERE workspace_id = $1 AND status = ANY($2::text[] || $3::text[]) AND ($5::uuid IS NULL OR branch_id = $5)`,
    [cfg.workspaceId, stageIds(stages, "open"), stageIds(stages, "reserved"), today, branchId]
  );
  // The sum is the shared totals() of each order (listOrders), never worked out twice.
  const { rows: sold } = await q(
    "SELECT id FROM crm_orders WHERE workspace_id = $1 AND delivery->>'date' = $2 AND status = ANY($3::text[]) AND ($4::uuid IS NULL OR branch_id = $4)",
    [cfg.workspaceId, today, stageIds(stages, "done"), branchId]
  );
  const done = await listOrders(q, cfg, { ids: sold.map((r) => r.id) });
  return { orders: { ...rows[0], soldToday: done.reduce((n, o) => n + o.totals.total, 0) } };
}
