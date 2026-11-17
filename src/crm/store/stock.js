// Stock: what is on the shelf and what accepted orders hold, per variant. Every change is a line
// in the ledger (crm_stock_moves); the database adds the lines up into crm_stock by itself and
// refuses a line that would sell or hold what isn't there (sql/crm/20-store.sql).
// Before stock is read for a rule, the variants are locked: two writes can't both take the last one.
import { z } from "zod";
import { HttpError } from "../../lib/http.js";
import { write } from "../db.js";
import { planWriteOff, planCount } from "../shared/store.js";
import { UUID, qOf, listProducts, listMovements, productsOf } from "./rows.js";

/** A rule said no: 422 { code: "rules", hard: [reason], soft: [reason] }. Reasons are codes, the app has the words. */
export const refused = (hard, soft = []) => new HttpError(422, hard.length ? "This can't be done as it stands." : "This is outside the rules the business set.", { code: "rules", hard, soft });

const uuid = z.string().regex(UUID, "This id doesn't look right.");
/** What a line of stock or of an order points at: a variant, or a product that has just one. */
export const target = { variantId: uuid.optional(), productId: uuid.optional() };
export const hasTarget = (v) => Boolean(v.variantId || v.productId);
/** A note someone typed, or one the app wrote in all three languages. */
const noteShape = z.union([
  z.string().trim().max(500),
  z.object({ en: z.string().trim().max(500), ru: z.string().trim().max(500), uz: z.string().trim().max(500) }).partial().strict(),
]);
const qty = z.number().int().min(1).max(1_000_000);

/**
 * The variant each item means: [{ variantId } | { productId }] → [variantId]. A product stands for
 * its one variant; a product with options needs the variant named.
 */
export async function resolveVariants(c, cfg, items) {
  const productIds = [...new Set(items.filter((i) => !i.variantId).map((i) => i.productId))];
  const byProduct = {};
  if (productIds.length) {
    const { rows } = await c.query(
      `SELECT p.id, COALESCE(array_agg(v.id ORDER BY v.position, v.created_at, v.id) FILTER (WHERE NOT v.archived), '{}') AS variants
         FROM crm_products p LEFT JOIN crm_variants v ON v.workspace_id = p.workspace_id AND v.product_id = p.id
        WHERE p.workspace_id = $1 AND p.id = ANY($2::uuid[]) GROUP BY p.id`,
      [cfg.workspaceId, productIds]
    );
    for (const r of rows) byProduct[r.id] = r.variants;
  }
  return items.map((i) => {
    if (i.variantId) return i.variantId;
    const variants = byProduct[i.productId];
    if (!variants) throw new HttpError(404, "Product not found", { code: "missing_product", productId: i.productId });
    if (variants.length !== 1) throw new HttpError(400, "This product has options. Say which one.", { code: "variant_required", productId: i.productId });
    return variants[0];
  });
}

/**
 * Locks these variants and reads their stock in the branch: { [variantId]: { variantId, productId,
 * name, onSale, archived, price, cost, stock, reserved } }. Holding the lock until the transaction
 * ends is what makes "is there enough?" still true when the ledger line is written.
 * A variant of another workspace, or one that doesn't exist, is refused as not found.
 */
export async function lockStock(c, cfg, variantIds, branchId = cfg.branchId) {
  const ids = [...new Set(variantIds)];
  const { rows } = await c.query(
    `SELECT v.id AS "variantId", v.product_id AS "productId", p.name AS product, v.option_values AS values, p.options, p.on_sale AS "onSale", v.archived,
            v.price, v.cost, COALESCE(s.on_hand, 0) AS stock, COALESCE(s.reserved, 0) AS reserved
       FROM crm_variants v
       JOIN crm_products p ON p.id = v.product_id
       LEFT JOIN crm_stock s ON s.variant_id = v.id AND s.branch_id = $3
      WHERE v.workspace_id = $1 AND v.id = ANY($2::uuid[])
      ORDER BY v.id FOR UPDATE OF v`,
    [cfg.workspaceId, ids, branchId]
  );
  const out = {};
  for (const { product, values, options, ...r } of rows) {
    // "T-shirt (M, Red)": the product's name with what was chosen, for a refusal that names it.
    const chosen = (options || []).map((o) => values?.[o.id]).filter(Boolean);
    // Money and the counters are BIGINT, which pg hands over as text.
    out[r.variantId] = { ...r, price: Number(r.price), cost: Number(r.cost), stock: Number(r.stock), reserved: Number(r.reserved), name: chosen.length ? `${product} (${chosen.join(", ")})` : product };
  }
  const missing = ids.find((id) => !out[id]);
  if (missing) throw new HttpError(404, "Product not found", { code: "missing_product", variantId: missing });
  return out;
}

/**
 * A variant that was put away (see updateProduct) takes no new stock: it is no longer on the
 * product. What is still on its shelf (goods that came back) can be written off or counted down.
 */
function refuseArchived(stock, ids) {
  const gone = ids.find((id) => stock[id].archived);
  if (gone) throw new HttpError(409, `${stock[gone].name} is no longer one of the product's variants.`, { code: "variant_archived", variantId: gone, productId: stock[gone].productId });
}

/**
 * Goods came back to variants that were put away after they sold out: each goes back on its
 * product, so what came back can be sold again. One stays put away when it no longer fits there:
 * the product has no options any more or they changed, another variant has the same values, or
 * another variant took its SKU. Its shelf can still be counted or written off.
 */
export async function reviveReturned(c, cfg, variantIds) {
  const { rows } = await c.query(
    `SELECT v.id, v.product_id, v.option_values AS values, v.sku, p.options
       FROM crm_variants v JOIN crm_products p ON p.id = v.product_id
      WHERE v.workspace_id = $1 AND v.id = ANY($2::uuid[]) AND v.archived`,
    [cfg.workspaceId, [...new Set(variantIds)]]
  );
  for (const v of rows) {
    const options = v.options || [];
    const values = v.values || {};
    if (!options.length || Object.keys(values).length !== options.length || !options.every((o) => o.values.includes(values[o.id]))) continue;
    const { rows: taken } = await c.query(
      `SELECT EXISTS (SELECT 1 FROM crm_variants w WHERE w.workspace_id = $1 AND w.product_id = $2 AND NOT w.archived AND w.option_values = $3::jsonb)
           OR ($4 <> '' AND EXISTS (SELECT 1 FROM crm_variants w WHERE w.workspace_id = $1 AND NOT w.archived AND lower(w.sku) = lower($4))) AS clash`,
      [cfg.workspaceId, v.product_id, JSON.stringify(values), v.sku]
    );
    if (!taken[0].clash) await c.query("UPDATE crm_variants SET archived = false WHERE workspace_id = $1 AND id = $2", [cfg.workspaceId, v.id]);
  }
}

/**
 * Writes ledger lines, in the order given: [{ variantId, type, qty, note?, reason?, orderId? }].
 * The database moves the counters. Returns the new lines' ids.
 */
export async function postMoves(c, cfg, user, moves, { branchId = cfg.branchId, orderId = null, note = "", reason = "" } = {}) {
  const ids = [];
  try {
    for (const m of moves) {
      const { rows } = await c.query(
        `INSERT INTO crm_stock_moves (workspace_id, variant_id, branch_id, type, qty, by_id, by_name, note, reason, order_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [cfg.workspaceId, m.variantId, branchId, m.type, m.qty, user?.id || null, user?.name || "", JSON.stringify(m.note ?? note), m.reason ?? reason, m.orderId ?? orderId]
      );
      ids.push(rows[0].id);
    }
  } catch (e) {
    // The rules checked this under a lock, so the database's own refusal should never be reached.
    // If it is, nothing is saved and the person is told to look again.
    if (e.code === "23514" && /^crm_stock_/.test(e.constraint || "")) throw new HttpError(409, "The stock changed a moment ago. Check the numbers and try again.", { code: "stock_changed" });
    // A number past what the database holds (more than 9 * 10^18 units): refused, never a 500.
    if (e.code === "22003") throw new HttpError(422, "That is more stock than can be kept.", { code: "rules", hard: [{ code: "qty_too_large" }], soft: [] });
    throw e;
  }
  return ids;
}

/** The changes a stock write answers with: the products it touched and the movements it made. */
async function stockChanges(c, cfg, variantIds, moveIds) {
  const q = qOf(c);
  const set = { products: await listProducts(q, cfg, await productsOf(c, cfg, variantIds)) };
  const movements = await listMovements(q, cfg, { ids: moveIds });
  if (movements.length) set.movements = movements;
  return { set };
}

/* ───── Receive, write off, count ───── */

export const receiveSchema = z
  .object({
    lines: z.array(z.object({ ...target, qty, cost: z.number().int().min(0).max(1e12).optional() }).strict().refine(hasTarget, "Say which product.")).min(1, "Add at least one product.").max(200),
    note: noteShape.optional(),
  })
  .strict();

/** Stock arrives. A cost given becomes the variant's cost from now on. */
export function receive(workspace, user, { lines, note = "" }) {
  return write(workspace.id, async (c, cfg) => {
    const ids = await resolveVariants(c, cfg, lines);
    refuseArchived(await lockStock(c, cfg, ids), ids);
    const costs = lines.map((l, i) => [ids[i], l.cost]).filter(([, cost]) => cost > 0);
    if (costs.length) {
      // The last cost given for a variant wins, as if the lines were entered one after another.
      const last = Object.fromEntries(costs);
      await c.query("UPDATE crm_variants v SET cost = x.cost FROM unnest($2::uuid[], $3::bigint[]) AS x(id, cost) WHERE v.workspace_id = $1 AND v.id = x.id", [cfg.workspaceId, Object.keys(last), Object.values(last)]);
    }
    const moveIds = await postMoves(c, cfg, user, lines.map((l, i) => ({ variantId: ids[i], type: "receipt", qty: l.qty })), { note });
    return { changes: await stockChanges(c, cfg, ids, moveIds) };
  });
}

export const writeOffSchema = z
  .object({
    ...target,
    qty,
    // Why: an id the app knows ("damaged", "expired", "lost", "other"). The words are the app's.
    reason: z.string().trim().regex(/^[A-Za-z0-9_-]{1,40}$/, "Say why the goods are written off."),
    note: noteShape.optional(),
  })
  .strict()
  .refine(hasTarget, "Say which product.");

/** Goods that can't be sold leave the shelf. Not more than is available: held goods belong to orders. */
export function writeOff(workspace, user, { qty: n, reason, note = "", ...which }) {
  return write(workspace.id, async (c, cfg) => {
    const [variantId] = await resolveVariants(c, cfg, [which]);
    const stock = await lockStock(c, cfg, [variantId]);
    const plan = planWriteOff(stock[variantId], n);
    if (!plan.ok) throw refused(plan.missing);
    const moveIds = await postMoves(c, cfg, user, plan.movements, { note, reason });
    return { changes: await stockChanges(c, cfg, [variantId], moveIds) };
  });
}

export const countSchema = z
  .object({ ...target, counted: z.number().int().min(0).max(1_000_000), note: noteShape.optional() })
  .strict()
  .refine(hasTarget, "Say which product.");

/** A stock count: on hand becomes what was counted, and the ledger keeps the difference. */
export function count(workspace, user, { counted, note = "", ...which }) {
  return write(workspace.id, async (c, cfg) => {
    const [variantId] = await resolveVariants(c, cfg, [which]);
    const stock = await lockStock(c, cfg, [variantId]);
    // A variant put away can be counted down (goods that came back and left again), never up.
    if (counted > stock[variantId].stock) refuseArchived(stock, [variantId]);
    const plan = planCount(stock[variantId], counted);
    if (!plan.ok) throw refused(plan.missing);
    const moveIds = await postMoves(c, cfg, user, plan.movements, { note });
    return { changes: await stockChanges(c, cfg, [variantId], moveIds), diff: plan.diff };
  });
}
