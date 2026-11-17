// The Store module: products, the stock ledger and orders. What a module exports is described
// in ../modules.js; the routes are in routes.js.
import { listProducts, listMovements, listOrders, qOf } from "./rows.js";

export { router } from "./routes.js";
export const keys = ["products", "movements", "orders"];

/* ───── What core asks a module ───── */

export async function snapshot({ q, cfg, want }) {
  const out = {};
  if (want("products")) out.products = await listProducts(q, cfg);
  if (want("movements")) out.movements = await listMovements(q, cfg);
  if (want("orders")) out.orders = await listOrders(q, cfg);
  return out;
}

// Where each settings list is used in this module's rows. A payment method counts for the orders
// that are to be paid by it and for those some money already came in by.
const USES = {
  sources: "SELECT source AS id, count(*)::int AS n FROM crm_orders WHERE workspace_id = $1 AND source = ANY($2::text[]) GROUP BY 1",
  orderStages: "SELECT status AS id, count(*)::int AS n FROM crm_orders WHERE workspace_id = $1 AND status = ANY($2::text[]) GROUP BY 1",
  deliveryMethods: "SELECT delivery->>'type' AS id, count(*)::int AS n FROM crm_orders WHERE workspace_id = $1 AND delivery->>'type' = ANY($2::text[]) GROUP BY 1",
  paymentMethods: `SELECT id, count(DISTINCT order_id)::int AS n FROM (
      SELECT payment AS id, id AS order_id FROM crm_orders WHERE workspace_id = $1 AND payment = ANY($2::text[])
      UNION SELECT method, order_id FROM crm_payments WHERE workspace_id = $1 AND method = ANY($2::text[])) u GROUP BY 1`,
  units: "SELECT unit AS id, count(*)::int AS n FROM crm_products WHERE workspace_id = $1 AND unit = ANY($2::text[]) GROUP BY 1",
  productCategories: "SELECT category AS id, count(*)::int AS n FROM crm_products WHERE workspace_id = $1 AND category = ANY($2::text[]) GROUP BY 1",
};
/** How many of this module's rows use these ids of a settings list: { [id]: n }. */
export async function countUses(c, workspaceId, list, ids) {
  if (!USES[list] || !ids.length) return {};
  const { rows } = await c.query(USES[list], [workspaceId, ids]);
  return Object.fromEntries(rows.map((r) => [r.id, r.n]));
}

/**
 * A step of the orders board was removed: its orders go to another step. Core lets that happen
 * only into a step of the same kind, so no stock moves with them.
 */
export async function moveStage(c, cfg, list, from, to) {
  if (list !== "orderStages") return null;
  const { rows } = await c.query("UPDATE crm_orders SET status = $3, updated_at = now() WHERE workspace_id = $1 AND status = $2 RETURNING id", [cfg.workspaceId, from, to]);
  return rows.length ? { set: { orders: await listOrders(qOf(c), cfg, { ids: rows.map((r) => r.id) }) } } : null;
}

/** A customer with orders can't be deleted: the orders would lose who they were for. */
export async function customerUses(c, workspaceId, customerId) {
  const { rows } = await c.query("SELECT count(*)::int AS n FROM crm_orders WHERE workspace_id = $1 AND customer_id = $2", [workspaceId, customerId]);
  return { orders: rows[0].n };
}

/** A customer's orders, newest first, for their panel. */
export async function customerHistory({ q, cfg }, customerId) {
  return { orders: await listOrders(q, cfg, { customerId }) };
}
