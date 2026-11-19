// The Store module's rows in the shapes the app knows (CONTRACT.md, DEMO-CONTRACT.md), and the
// pieces every write of an order shares: locking it, adding a payment, answering with changes.
// Every reader takes `q(text, params)`: the snapshot's read transaction or a write's client, so
// what a write answers with is read inside the same transaction that made the change.
import { notFound } from "../../core/http.js";
import { wall, isUuid, pageOf } from "../db.js";
import { totals } from "../shared/store.js";

/* ───── Products ───── */

/**
 * A product as the pages read it. Price, cost and SKU are its first variant's; stock, reserved
 * and lowAt are sums over its variants, so `stock - reserved` is what can still be sold of the
 * product as a whole. `variants` always lists them all (one for a product without options):
 * an order line names the variant. With more than one branch (and the rows not narrowed to one),
 * the product and each variant also carry `branches`: { [branchId]: { stock, reserved } }.
 */
function productRow(r) {
  const variants = (r.variants || []).map(({ archived, branches, ...v }) => ({ ...v, ...(archived ? { archived: true } : {}), ...(r.multi ? { branches: branches || {} } : {}) }));
  const live = variants.filter((v) => !v.archived);
  const first = live[0] || variants[0] || { sku: "", price: 0, cost: 0 };
  const sum = (key, list = variants) => list.reduce((s, v) => s + v[key], 0);
  return {
    id: r.id,
    name: r.name,
    sku: first.sku,
    category: r.category,
    price: first.price,
    cost: first.cost,
    unit: r.unit,
    image: r.image,
    images: [r.image, ...(r.gallery || [])].filter(Boolean),
    description: r.description,
    onSale: r.onSale,
    stock: sum("stock"),
    reserved: sum("reserved"),
    lowAt: sum("lowAt", live),
    options: r.options,
    variants,
    ...(r.multi ? { branches: perBranch(variants) } : {}),
    createdAt: r.createdAt,
  };
}
/** A product's stock and holds per branch: its variants' added up. */
function perBranch(variants) {
  const out = {};
  for (const v of variants) {
    for (const [id, n] of Object.entries(v.branches)) {
      const sum = (out[id] ||= { stock: 0, reserved: 0 });
      sum.stock += n.stock;
      sum.reserved += n.reserved;
    }
  }
  return out;
}

/**
 * Products, newest first. `ids`: only these. The variants and their stock are added up once for
 * all products; with `ids`, only those products' stock is (a write answers about a few products).
 * `branchId`: the stock of that branch only.
 */
export async function listProducts(q, cfg, ids, branchId = null) {
  if (ids && !ids.length) return [];
  const only = (col) => (ids ? `AND ${col} = ANY($3::uuid[])` : "");
  const params = ids ? [cfg.workspaceId, cfg.timezone, ids] : [cfg.workspaceId, cfg.timezone];
  const branch = branchId ? `AND branch_id = $${params.push(branchId)}` : "";
  const { rows } = await q(
    `WITH s AS (
       SELECT variant_id, sum(on_hand)::bigint AS on_hand, sum(reserved)::bigint AS reserved,
              json_object_agg(branch_id, json_build_object('stock', on_hand, 'reserved', reserved)) AS branches FROM crm_stock
        WHERE workspace_id = $1 ${branch} ${ids ? "AND variant_id IN (SELECT id FROM crm_variants WHERE workspace_id = $1 AND product_id = ANY($3::uuid[]))" : ""}
        GROUP BY variant_id
     ), v AS (
       SELECT v.product_id, json_agg(json_build_object('id', v.id, 'values', v.option_values, 'sku', v.sku, 'price', v.price, 'cost', v.cost,
                'stock', COALESCE(s.on_hand, 0), 'reserved', COALESCE(s.reserved, 0), 'lowAt', v.low_at, 'archived', v.archived, 'branches', s.branches)
              ORDER BY v.archived, v.position, v.created_at, v.id) AS variants
         FROM crm_variants v LEFT JOIN s ON s.variant_id = v.id
        WHERE v.workspace_id = $1 ${only("v.product_id")}
        GROUP BY v.product_id
     )
     SELECT p.id, p.name, p.category, p.unit, p.image, p.gallery, p.description, p.on_sale AS "onSale", p.options, ${wall("p.created_at", "$2")} AS "createdAt", v.variants,
            ${branchId ? "false" : MULTI} AS multi
       FROM crm_products p LEFT JOIN v ON v.product_id = p.id
      WHERE p.workspace_id = $1 ${only("p.id")}
      ORDER BY p.created_at DESC, p.id`,
    params
  );
  return rows.map(productRow);
}

/** Whether the workspace has more than one branch: only then do rows say where their stock is. */
const MULTI = "(SELECT count(*) > 1 FROM crm_branches b WHERE b.workspace_id = $1)";

/* ───── Movements ───── */

// What the Stock page lists: goods coming in and going out. Holding goods for an order and
// letting them go again are ledger lines too, but they move no goods, so they stay out of it.
const SHOWN = "m.type NOT IN ('reserve', 'release')";

/**
 * Stock movements, newest first. `ids`: only these; `branchId`: that branch's only. With more than
 * one branch each says where (`branchId`); goods moved between branches (`transfer`: a minus where
 * they left, a plus where they arrived) also say `fromBranchId` and `toBranchId`.
 */
export async function listMovements(q, cfg, ids, branchId = null) {
  return readMovements(q, cfg, { ids, branchId });
}

/**
 * A page of movements, newest first: { movements, next }. `productId`: one product's; `before`: the
 * id of the last movement of the page before; `branchId`: one branch's. The snapshot's window is
 * the first page.
 */
export async function pageMovements(q, cfg, { limit, ...where }) {
  const page = pageOf(await readMovements(q, cfg, { ...where, limit: limit + 1 }), limit);
  return { movements: page.rows, next: page.next };
}

async function readMovements(q, cfg, { ids, branchId, productId, before, limit }) {
  if (ids && !ids.length) return [];
  const params = [cfg.workspaceId, cfg.timezone];
  const and = [SHOWN];
  const add = (sql, value) => and.push(sql.replaceAll("$x", `$${params.push(value)}`));
  if (ids) add("m.id = ANY($x::uuid[])", ids);
  if (branchId) add("m.branch_id = $x", branchId);
  if (productId) add("m.variant_id IN (SELECT id FROM crm_variants WHERE workspace_id = $1 AND product_id = $x)", productId);
  if (before) add("m.seq < (SELECT seq FROM crm_stock_moves WHERE workspace_id = $1 AND id = $x)", before);
  const { rows } = await q(
    `SELECT m.id, v.product_id AS "productId", m.variant_id AS "variantId", m.type, m.qty, ${wall("m.at", "$2")} AS at, m.by_name AS by,
            m.note, m.reason, m.order_id AS "orderId", m.branch_id AS "branchId", m.other_branch_id AS "otherBranchId", ${MULTI} AS multi
       FROM crm_stock_moves m JOIN crm_variants v ON v.workspace_id = m.workspace_id AND v.id = m.variant_id
      WHERE m.workspace_id = $1 AND ${and.join(" AND ")}
      ORDER BY m.seq DESC ${limit ? `LIMIT ${Number(limit)}` : ""}`,
    params
  );
  // qty is BIGINT, which pg hands over as text.
  return rows.map(({ orderId, reason, qty, branchId: here, otherBranchId: other, multi, ...m }) => ({
    ...m,
    qty: Number(qty),
    ...(reason ? { reason } : {}),
    ...(orderId ? { orderId } : {}),
    ...(multi ? { branchId: here } : {}),
    ...(other ? (Number(qty) < 0 ? { fromBranchId: here, toBranchId: other } : { fromBranchId: other, toBranchId: here }) : {}),
  }));
}

/* ───── Orders ───── */

/**
 * An order as the pages read it, with its money added up: `totals` (see totals() in the shared
 * rules, which read the step's kind from `stages`) and `paid`, true when nothing is owed any more.
 */
function orderRow(r, stages) {
  const order = {
    id: r.id,
    number: Number(r.number),
    customerId: r.customerId,
    lines: (r.lines || []).map((l) => ({ ...l, price: Number(l.price), discount: Number(l.discount) })),
    status: r.status,
    delivery: r.delivery,
    payment: r.payment,
    discount: Number(r.discount),
    payments: (r.payments || []).map((p) => ({ ...p, amount: Number(p.amount) })),
    source: r.source,
    note: r.note,
    fields: r.fields,
    ...(r.returned ? { returned: true } : {}),
    branchId: r.branchId,
    createdAt: r.createdAt,
    history: r.history,
  };
  const sums = totals(order, stages);
  return { ...order, totals: sums, paid: sums.balance <= 0 };
}

// An order's lines and payments, in the shape the app reads ($2: the workspace's time zone).
const LINE = `json_build_object('id', l.id, 'productId', v.product_id, 'variantId', l.variant_id, 'qty', l.qty, 'price', l.price, 'discount', l.discount) ORDER BY l.position, l.id`;
const LINES = "crm_order_lines l JOIN crm_variants v ON v.workspace_id = l.workspace_id AND v.id = l.variant_id";
const PAYMENT = `json_build_object('id', p.id, 'amount', p.amount, 'method', p.method, 'at', ${wall("p.at", "$2")}, 'by', p.by_name, 'note', p.note) ORDER BY p.seq`;
const ORDER = `o.id, o.number, o.customer_id AS "customerId", o.status, o.delivery, o.payment, o.discount, o.source, o.note, o.fields,
  o.history, o.returned, o.branch_id AS "branchId", ${wall("o.created_at", "$2")} AS "createdAt", l.lines, p.payments`;

/**
 * Orders, newest first. `where`, any of: `ids`; `customerId`; `branchId` (one branch's); `open` +
 * `since` (orders in those steps, and every other one changed since that day: the snapshot's
 * window); `from`, `to` (made on those days, both included); `before` (an order's id: the ones made
 * before it, for the next page); `limit`. `lock`: "FOR UPDATE" inside a write.
 * Every order, or one branch's: their lines and payments are gathered once over the tables. Fewer:
 * each order's are looked up by its index (LATERAL), so the work follows the orders asked for.
 */
export async function listOrders(q, cfg, where = {}, lock = "") {
  if (where.ids && !where.ids.length) return [];
  const params = [cfg.workspaceId, cfg.timezone];
  const and = [];
  const add = (sql, ...values) => and.push(values.reduce((text, v) => text.replace("$x", `$${params.push(v)}`), sql));
  if (where.ids) add("o.id = ANY($x::uuid[])", where.ids);
  if (where.customerId) add("o.customer_id = $x", where.customerId);
  if (where.since) add("(o.status = ANY($x::text[]) OR o.updated_at >= ($x::date::timestamp AT TIME ZONE $2))", where.open, where.since);
  if (where.from) add("o.created_at >= ($x::date::timestamp AT TIME ZONE $2)", where.from);
  if (where.to) add("o.created_at < (($x::date + 1)::timestamp AT TIME ZONE $2)", where.to);
  if (where.before) add("(o.created_at, o.number) < (SELECT created_at, number FROM crm_orders WHERE workspace_id = $1 AND id = $x)", where.before);
  const whole = !and.length && !where.limit;
  if (where.branchId) add("o.branch_id = $x", where.branchId);
  const tail = `WHERE o.workspace_id = $1 ${and.map((x) => `AND ${x}`).join(" ")}
      ORDER BY o.created_at DESC, o.number DESC ${where.limit ? `LIMIT ${Number(where.limit)}` : ""} ${lock ? `${lock} OF o` : ""}`;
  const { rows } = await q(
    whole
      ? `WITH l AS (SELECT l.order_id, json_agg(${LINE}) AS lines FROM ${LINES} WHERE l.workspace_id = $1 GROUP BY l.order_id),
              p AS (SELECT p.order_id, json_agg(${PAYMENT}) AS payments FROM crm_payments p WHERE p.workspace_id = $1 GROUP BY p.order_id)
         SELECT ${ORDER} FROM crm_orders o LEFT JOIN l ON l.order_id = o.id LEFT JOIN p ON p.order_id = o.id ${tail}`
      : `SELECT ${ORDER} FROM crm_orders o
           LEFT JOIN LATERAL (SELECT json_agg(${LINE}) AS lines FROM ${LINES} WHERE l.workspace_id = o.workspace_id AND l.order_id = o.id) l ON true
           LEFT JOIN LATERAL (SELECT json_agg(${PAYMENT}) AS payments FROM crm_payments p WHERE p.workspace_id = o.workspace_id AND p.order_id = o.id) p ON true
         ${tail}`,
    params
  );
  return rows.map((r) => orderRow(r, cfg.data.orderStages));
}

/* ───── What every write of an order shares ───── */

/**
 * The order, locked for this write. Another workspace's id reads as "not found", and so does
 * another branch's for a team member limited to one (`only`: their branch).
 */
export async function lockOrder(q, cfg, id, only = null) {
  const [order] = isUuid(id) ? await listOrders(q, cfg, { ids: [id] }, "FOR UPDATE") : [];
  if (!order || (only && order.branchId !== only)) throw notFound("Order not found");
  return order;
}

/**
 * One line of an order's history. `text` is a code the app has words for. A customer's own order
 * says so (`customer: true`) and where they made it (`via`: "page", "ai").
 */
export const historyLine = (cfg, user, text, extra) => ({ at: cfg.now, text, by: user?.name || "", ...(user?.by === "customer" ? { customer: true, via: user.via } : {}), ...extra });

/** Money for an order: a plus when it comes in, a minus when it goes back. */
export const addPayment = (c, cfg, user, orderId, sum, method, note = "") =>
  c.query("INSERT INTO crm_payments (workspace_id, order_id, amount, method, by_id, by_name, note) VALUES ($1, $2, $3, $4, $5, $6, $7)", [cfg.workspaceId, orderId, sum, method, user?.id || null, user?.name || "", note]);

/** The products these variants belong to. */
async function productsOf(q, cfg, variantIds) {
  const { rows } = await q("SELECT DISTINCT product_id AS id FROM crm_variants WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [cfg.workspaceId, [...new Set(variantIds)]]);
  return rows.map((r) => r.id);
}

/**
 * The changes every Store write answers with, read inside its transaction: the order it wrote,
 * the products it touched (by `productIds`, or by the variants whose stock moved) and the ledger
 * lines it made. `more`: other rows to send along ({ customers }). `branchId`: the products' stock
 * at that branch only (the writer is a team member limited to it).
 */
export async function storeChanges(q, cfg, { orderId, productIds, variantIds = [], moveIds = [], more, branchId } = {}) {
  const set = { ...(orderId ? { orders: await listOrders(q, cfg, { ids: [orderId] }) } : {}), ...more };
  const products = productIds || (variantIds.length ? await productsOf(q, cfg, variantIds) : []);
  if (products.length) set.products = await listProducts(q, cfg, products, branchId);
  const movements = await listMovements(q, cfg, moveIds);
  if (movements.length) set.movements = movements;
  return { set };
}
