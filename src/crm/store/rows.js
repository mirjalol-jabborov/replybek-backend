// The Store module's rows in the shapes the app knows (CONTRACT.md, DEMO-CONTRACT.md), and the
// pieces every write of an order shares: locking it, adding a payment, answering with changes.
// Every reader takes `q(text, params)`: the snapshot's read transaction or a write's client, so
// what a write answers with is read inside the same transaction that made the change.
import { notFound } from "../../lib/http.js";
import { wall, isUuid } from "../db.js";
import { totals, isPaid } from "../shared/store.js";

/* ───── Products ───── */

/**
 * A product as the pages read it. Price, cost and SKU are its first variant's; stock, reserved
 * and lowAt are sums over its variants, so `stock - reserved` is what can still be sold of the
 * product as a whole. `variants` always lists them all (one for a product without options):
 * an order line names the variant.
 */
function productRow(r) {
  const variants = (r.variants || []).map(({ archived, ...v }) => (archived ? { ...v, archived: true } : v));
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
    onSale: r.onSale,
    stock: sum("stock"),
    reserved: sum("reserved"),
    lowAt: sum("lowAt", live),
    options: r.options,
    variants,
    createdAt: r.createdAt,
  };
}

/**
 * Products, newest first. `ids`: only these. The variants and their stock are added up once for
 * all products; with `ids`, only those products' stock is (a write answers about a few products).
 */
export async function listProducts(q, cfg, ids) {
  if (ids && !ids.length) return [];
  const only = (col) => (ids ? `AND ${col} = ANY($3::uuid[])` : "");
  const { rows } = await q(
    `WITH s AS (
       SELECT variant_id, sum(on_hand)::bigint AS on_hand, sum(reserved)::bigint AS reserved FROM crm_stock
        WHERE workspace_id = $1 ${ids ? "AND variant_id IN (SELECT id FROM crm_variants WHERE workspace_id = $1 AND product_id = ANY($3::uuid[]))" : ""}
        GROUP BY variant_id
     ), v AS (
       SELECT v.product_id, json_agg(json_build_object('id', v.id, 'values', v.option_values, 'sku', v.sku, 'price', v.price, 'cost', v.cost,
                'stock', COALESCE(s.on_hand, 0), 'reserved', COALESCE(s.reserved, 0), 'lowAt', v.low_at, 'archived', v.archived)
              ORDER BY v.archived, v.position, v.created_at, v.id) AS variants
         FROM crm_variants v LEFT JOIN s ON s.variant_id = v.id
        WHERE v.workspace_id = $1 ${only("v.product_id")}
        GROUP BY v.product_id
     )
     SELECT p.id, p.name, p.category, p.unit, p.image, p.on_sale AS "onSale", p.options, ${wall("p.created_at", "$2")} AS "createdAt", v.variants
       FROM crm_products p LEFT JOIN v ON v.product_id = p.id
      WHERE p.workspace_id = $1 ${only("p.id")}
      ORDER BY p.created_at DESC, p.id`,
    ids ? [cfg.workspaceId, cfg.timezone, ids] : [cfg.workspaceId, cfg.timezone]
  );
  return rows.map(productRow);
}

/* ───── Movements ───── */

// What the Stock page lists: goods coming in and going out. Holding goods for an order and
// letting them go again are ledger lines too, but they move no goods, so they stay out of it.
const SHOWN = "m.type NOT IN ('reserve', 'release')";

/** Stock movements, newest first. `ids`: only these. */
export async function listMovements(q, cfg, ids) {
  if (ids && !ids.length) return [];
  const { rows } = await q(
    `SELECT m.id, v.product_id AS "productId", m.variant_id AS "variantId", m.type, m.qty, ${wall("m.at", "$2")} AS at, m.by_name AS by,
            m.note, m.reason, m.order_id AS "orderId"
       FROM crm_stock_moves m JOIN crm_variants v ON v.workspace_id = m.workspace_id AND v.id = m.variant_id
      WHERE m.workspace_id = $1 AND ${SHOWN} ${ids ? "AND m.id = ANY($3::uuid[])" : ""}
      ORDER BY m.seq DESC`,
    ids ? [cfg.workspaceId, cfg.timezone, ids] : [cfg.workspaceId, cfg.timezone]
  );
  // qty is BIGINT, which pg hands over as text.
  return rows.map(({ orderId, reason, qty, ...m }) => ({ ...m, qty: Number(qty), ...(reason ? { reason } : {}), ...(orderId ? { orderId } : {}) }));
}

/* ───── Orders ───── */

/**
 * An order as the pages read it, with its money added up: `totals` (see totals() in the shared
 * rules) and `paid`, true when nothing is owed any more.
 */
function orderRow(r) {
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
  return { ...order, totals: totals(order), paid: isPaid(order) };
}

/**
 * Orders, newest first. `where`: { ids } or { customerId }. `lock`: "FOR UPDATE" inside a write.
 * Lines and payments are gathered once per query, by order, for the same orders the query lists.
 */
export async function listOrders(q, cfg, where = {}, lock = "") {
  if (where.ids && !where.ids.length) return [];
  const which = (o) => (where.ids ? `AND ${o}id = ANY($3::uuid[])` : where.customerId ? `AND ${o}customer_id = $3` : "");
  // The lines' and payments' own filter: their orders, through the order id they carry.
  const of = (alias) => (where.ids ? `AND ${alias}.order_id = ANY($3::uuid[])` : where.customerId ? `AND ${alias}.order_id IN (SELECT id FROM crm_orders WHERE workspace_id = $1 ${which("")})` : "");
  const { rows } = await q(
    `WITH l AS (
       SELECT l.order_id, json_agg(json_build_object('id', l.id, 'productId', v.product_id, 'variantId', l.variant_id, 'qty', l.qty, 'price', l.price, 'discount', l.discount) ORDER BY l.position, l.id) AS lines
         FROM crm_order_lines l JOIN crm_variants v ON v.workspace_id = l.workspace_id AND v.id = l.variant_id
        WHERE l.workspace_id = $1 ${of("l")}
        GROUP BY l.order_id
     ), p AS (
       SELECT p.order_id, json_agg(json_build_object('id', p.id, 'amount', p.amount, 'method', p.method, 'at', ${wall("p.at", "$2")}, 'by', p.by_name, 'note', p.note) ORDER BY p.seq) AS payments
         FROM crm_payments p
        WHERE p.workspace_id = $1 ${of("p")}
        GROUP BY p.order_id
     )
     SELECT o.id, o.number, o.customer_id AS "customerId", o.status, o.delivery, o.payment, o.discount, o.source, o.note, o.fields,
            o.history, o.returned, o.branch_id AS "branchId", ${wall("o.created_at", "$2")} AS "createdAt", l.lines, p.payments
       FROM crm_orders o LEFT JOIN l ON l.order_id = o.id LEFT JOIN p ON p.order_id = o.id
      WHERE o.workspace_id = $1 ${which("o.")}
      ORDER BY o.created_at DESC, o.number DESC ${lock ? `${lock} OF o` : ""}`,
    where.ids || where.customerId ? [cfg.workspaceId, cfg.timezone, where.ids || where.customerId] : [cfg.workspaceId, cfg.timezone]
  );
  return rows.map(orderRow);
}

/* ───── What every write of an order shares ───── */

/** The order, locked for this write. Another workspace's id reads as "not found". */
export async function lockOrder(q, cfg, id) {
  const [order] = isUuid(id) ? await listOrders(q, cfg, { ids: [id] }, "FOR UPDATE") : [];
  if (!order) throw notFound("Order not found");
  return order;
}

/** One line of an order's history. `text` is a code the app has words for. */
export const historyLine = (cfg, user, text, extra) => ({ at: cfg.now, text, by: user?.name || "", ...extra });

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
 * lines it made. `more`: other rows to send along ({ customers }).
 */
export async function storeChanges(q, cfg, { orderId, productIds, variantIds = [], moveIds = [], more } = {}) {
  const set = { ...(orderId ? { orders: await listOrders(q, cfg, { ids: [orderId] }) } : {}), ...more };
  const products = productIds || (variantIds.length ? await productsOf(q, cfg, variantIds) : []);
  if (products.length) set.products = await listProducts(q, cfg, products);
  const movements = await listMovements(q, cfg, moveIds);
  if (movements.length) set.movements = movements;
  return { set };
}
