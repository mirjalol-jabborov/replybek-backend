// The Store module: products, the stock ledger and orders. What a module exports is described
// in ../modules.js; the routes are in routes.js.
import { asQ } from "../db.js";
import { stageIds } from "../shared/index.js";
import { listProducts, listMovements, pageMovements, listOrders } from "./rows.js";
import { orderCounts } from "./counts.js";

export { router } from "./routes.js";
export const keys = ["products", "movements", "orders"];

// What the public pages and the AI agent's bridge ask the Store for: orders a customer makes
// themselves, the store as customers see it, and its pictures.
export { createOrder } from "./orders.js";
export { listProducts, listOrders } from "./rows.js";
export { productsForCustomers, findForCustomers, orderedByCustomerToday } from "./for-customers.js";
export { uploadedName, shownToCustomers, sendImage } from "./images.js";
// What moving goods between branches (../branches/transfer.js) writes with: the Store's own ledger steps.
export { target, hasTarget, resolveVariants, lockStock, postMoves } from "./stock.js";
export { storeChanges, listMovements } from "./rows.js";
// What an Excel import of products (../exchange) checks and writes with: the product form's shape
// and the note on opening stock.
export { productCreateSchema, OPENING } from "./products.js";

/* ───── What core asks a module ───── */

// `branchId`: narrowed to one branch (?branch=, or a team member limited to one): its orders, its
// ledger lines, and each product's stock there. `recent` (the window): every order that is open or
// reserved, and every other one changed since its first day; the newest `moves` movements (the rest
// come page by page from `next`). Products are always whole. `ids`: only those rows.
export async function snapshot({ q, cfg, want, branchId, recent, ids }) {
  const out = {};
  const windows = {};
  if (want("products")) out.products = await listProducts(q, cfg, ids || undefined, branchId);
  if (want("movements")) {
    if (recent) {
      const page = await pageMovements(q, cfg, { branchId, limit: recent.moves });
      out.movements = page.movements;
      windows.movements = { limit: recent.moves, next: page.next };
    } else out.movements = await listMovements(q, cfg, ids || undefined, branchId);
  }
  if (want("orders")) {
    const window = recent ? { open: stageIds(cfg.data.orderStages, "open", "reserved"), since: recent.from } : {};
    out.orders = await listOrders(q, cfg, { branchId, ...(ids ? { ids } : {}), ...window });
    if (recent) windows.orders = { from: recent.from };
  }
  return recent ? { ...out, windows } : out;
}

/** The sidebar's and Today's numbers of orders (see counts.js). */
export const counts = (ctx) => orderCounts(ctx.q, ctx.cfg, ctx.branchId || null);

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
  return rows.length ? { set: { orders: await listOrders(asQ(c), cfg, { ids: rows.map((r) => r.id) }) } } : null;
}

/** What still goes on at a branch: goods on its shelves (units on hand) and orders still open there. */
export async function branchUses(c, cfg, branchId) {
  const { rows } = await c.query(
    `SELECT (SELECT COALESCE(sum(on_hand), 0)::float8 FROM crm_stock WHERE workspace_id = $1 AND branch_id = $2 AND on_hand > 0) AS stock,
            (SELECT count(*)::int FROM crm_orders WHERE workspace_id = $1 AND branch_id = $2 AND status = ANY($3::text[])) AS orders`,
    [cfg.workspaceId, branchId, stageIds(cfg.data.orderStages, "open", "reserved")]
  );
  return rows[0];
}

/** A customer with orders can't be deleted: the orders would lose who they were for. */
export async function customerUses(c, workspaceId, customerId) {
  const { rows } = await c.query("SELECT count(*)::int AS n FROM crm_orders WHERE workspace_id = $1 AND customer_id = $2", [workspaceId, customerId]);
  return { orders: rows[0].n };
}

/** A customer's orders, newest first, for their panel. */
export async function customerHistory({ q, cfg, branchId }, customerId) {
  return { orders: await listOrders(q, cfg, { customerId, branchId }) };
}
