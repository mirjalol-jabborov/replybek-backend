// Stock: what is on the shelf and what accepted orders hold, per variant. Every change is a line
// in the ledger (crm_stock_moves); the database adds the lines up into crm_stock by itself and
// refuses a line that would sell or hold what isn't there (sql/crm/20-store.sql).
// Before stock is read for a rule, the variants are locked: two writes can't both take the last one.
import { z } from "zod";
import { HttpError } from "../../core/http.js";
import { write } from "../db.js";
import { conflict, refusal } from "../errors.js";
import { uuid, money, label } from "../shapes.js";
import { same } from "../shared/index.js";
import { planWriteOff, planCount } from "../shared/store.js";
import { storeChanges } from "./rows.js";

/** What a line of stock or of an order points at: a variant, or a product that has just one. */
export const target = { variantId: uuid.optional(), productId: uuid.optional() };
export const hasTarget = (v) => Boolean(v.variantId || v.productId);
/** A note someone typed, or one the app wrote in all three languages. */
const noteShape = label(500);
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
  if (gone) throw conflict(`${stock[gone].name} is no longer one of the product's variants.`, "variant_archived", { variantId: gone, productId: stock[gone].productId });
}

/**
 * Goods came back to variants that were put away after they sold out: each goes back on its
 * product, so what came back can be sold again. One stays put away when it no longer fits there:
 * the product has no options any more or they changed, another variant has the same values, or
 * another variant took its SKU. Its shelf can still be counted or written off.
 */
export async function reviveReturned(c, cfg, variantIds) {
  // Each one with whether a variant in use already has its values or its SKU.
  const { rows } = await c.query(
    `SELECT v.id, v.product_id, v.option_values AS values, lower(v.sku) AS sku, p.options,
            EXISTS (SELECT 1 FROM crm_variants w WHERE w.workspace_id = v.workspace_id AND w.product_id = v.product_id AND NOT w.archived AND w.option_values = v.option_values)
              OR (v.sku <> '' AND EXISTS (SELECT 1 FROM crm_variants w WHERE w.workspace_id = v.workspace_id AND NOT w.archived AND lower(w.sku) = lower(v.sku))) AS clash
       FROM crm_variants v JOIN crm_products p ON p.workspace_id = v.workspace_id AND p.id = v.product_id
      WHERE v.workspace_id = $1 AND v.id = ANY($2::uuid[]) AND v.archived
      ORDER BY v.id`,
    [cfg.workspaceId, [...new Set(variantIds)]]
  );
  // One after another: a variant brought back takes its values and SKU, so a later one can clash with it.
  const back = [];
  for (const v of rows) {
    const options = v.options || [];
    const values = v.values || {};
    if (!options.length || Object.keys(values).length !== options.length || !options.every((o) => o.values.includes(values[o.id]))) continue;
    const twin = back.some((b) => (b.product_id === v.product_id && same(b.values, values)) || (v.sku && b.sku === v.sku));
    if (!v.clash && !twin) back.push(v);
  }
  if (back.length) await c.query("UPDATE crm_variants SET archived = false WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [cfg.workspaceId, back.map((v) => v.id)]);
}

/**
 * Writes ledger lines, in the order given: [{ variantId, type, qty, note?, reason?, orderId? }].
 * The database moves the counters. Returns the new lines' ids.
 */
export async function postMoves(c, cfg, user, moves, { branchId = cfg.branchId, orderId = null, note = "", reason = "" } = {}) {
  if (!moves.length) return [];
  const col = (f) => moves.map(f);
  try {
    // One statement for all the lines. They go in, and the trigger adds them up, in the order given:
    // seq follows that order, so a release still comes before the sale it belongs to.
    const { rows } = await c.query(
      `INSERT INTO crm_stock_moves (workspace_id, variant_id, branch_id, type, qty, by_id, by_name, note, reason, order_id)
       SELECT $1, m.variant_id, $2, m.type, m.qty, $3, $4, m.note, m.reason, m.order_id
         FROM unnest($5::uuid[], $6::text[], $7::bigint[], $8::jsonb[], $9::text[], $10::uuid[]) WITH ORDINALITY AS m(variant_id, type, qty, note, reason, order_id, n)
        ORDER BY m.n
       RETURNING id, seq`,
      [
        cfg.workspaceId, branchId, user?.id || null, user?.name || "",
        col((m) => m.variantId), col((m) => m.type), col((m) => m.qty), col((m) => JSON.stringify(m.note ?? note)), col((m) => m.reason ?? reason), col((m) => m.orderId ?? orderId),
      ]
    );
    return rows.sort((a, b) => Number(a.seq) - Number(b.seq)).map((r) => r.id);
  } catch (e) {
    // The rules checked this under a lock, so the database's own refusal should never be reached.
    // If it is, nothing is saved and the person is told to look again.
    if (e.code === "23514" && /^crm_stock_/.test(e.constraint || "")) throw conflict("The stock changed a moment ago. Check the numbers and try again.", "stock_changed");
    // A number past what the database holds (more than 9 * 10^18 units): refused, never a 500.
    if (e.code === "22003") throw refusal([{ code: "qty_too_large" }], [], { message: "That is more stock than can be kept." });
    throw e;
  }
}

/* ───── Receive, write off, count ───── */

export const receiveSchema = z
  .object({
    lines: z.array(z.object({ ...target, qty, cost: money.optional() }).strict().refine(hasTarget, "Say which product.")).min(1, "Add at least one product.").max(200),
    note: noteShape.optional(),
  })
  .strict();

/** Stock arrives. A cost given becomes the variant's cost from now on. */
export function receive(workspace, user, { lines, note = "" }) {
  return write(workspace.id, async (c, cfg, q) => {
    const ids = await resolveVariants(c, cfg, lines);
    refuseArchived(await lockStock(c, cfg, ids), ids);
    const costs = lines.map((l, i) => [ids[i], l.cost]).filter(([, cost]) => cost > 0);
    if (costs.length) {
      // The last cost given for a variant wins, as if the lines were entered one after another.
      const last = Object.fromEntries(costs);
      await c.query("UPDATE crm_variants v SET cost = x.cost FROM unnest($2::uuid[], $3::bigint[]) AS x(id, cost) WHERE v.workspace_id = $1 AND v.id = x.id", [cfg.workspaceId, Object.keys(last), Object.values(last)]);
    }
    const moveIds = await postMoves(c, cfg, user, lines.map((l, i) => ({ variantId: ids[i], type: "receipt", qty: l.qty })), { note });
    return { changes: await storeChanges(q, cfg, { variantIds: ids, moveIds }) };
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
  return write(workspace.id, async (c, cfg, q) => {
    const [variantId] = await resolveVariants(c, cfg, [which]);
    const stock = await lockStock(c, cfg, [variantId]);
    const plan = planWriteOff(stock[variantId], n);
    if (!plan.ok) throw refusal(plan.missing);
    const moveIds = await postMoves(c, cfg, user, plan.movements, { note, reason });
    return { changes: await storeChanges(q, cfg, { variantIds: [variantId], moveIds }) };
  });
}

export const countSchema = z
  .object({ ...target, counted: z.number().int().min(0).max(1_000_000), note: noteShape.optional() })
  .strict()
  .refine(hasTarget, "Say which product.");

/** A stock count: on hand becomes what was counted, and the ledger keeps the difference. */
export function count(workspace, user, { counted, note = "", ...which }) {
  return write(workspace.id, async (c, cfg, q) => {
    const [variantId] = await resolveVariants(c, cfg, [which]);
    const stock = await lockStock(c, cfg, [variantId]);
    // A variant put away can be counted down (goods that came back and left again), never up.
    if (counted > stock[variantId].stock) refuseArchived(stock, [variantId]);
    const plan = planCount(stock[variantId], counted);
    if (!plan.ok) throw refusal(plan.missing);
    const moveIds = await postMoves(c, cfg, user, plan.movements, { note });
    return { changes: await storeChanges(q, cfg, { variantIds: [variantId], moveIds }), diff: plan.diff };
  });
}
