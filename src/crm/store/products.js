// Products. Price, SKU and stock live on a product's variants: a plain product has one that
// nobody sees, a product with options (size, colour) has one per combination on sale.
// The app may write a plain product the demo's way (sku, price, cost, lowAt on the product itself)
// or send `variants`.
import { z } from "zod";
import { HttpError, notFound } from "../../lib/http.js";
import { write } from "../db.js";
import { hasId } from "../shared/index.js";
import { UUID, qOf, listProducts, listMovements } from "./rows.js";
import { lockStock, postMoves } from "./stock.js";
import { checkImage, dropUpload } from "./images.js";

const OPENING = { en: "Opening stock", ru: "Начальный остаток", uz: "Boshlangʻich qoldiq" };

/* ───── Shapes ───── */

const id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, "An id is 1 to 40 letters, digits, - or _.");
const money = z.number().int().min(0).max(1e12);
const whole = z.number().int().min(0).max(1_000_000);
const text = (max) => z.string().trim().min(1).max(max);
// A picture is a path on the same site: a static one ("/products/x.jpg") or an uploaded one (see uploadImage).
const image = z.string().trim().max(300).regex(/^(\/(?!\/)[A-Za-z0-9_\-./%]*)?$/, "A picture is a path that starts with /.");
const option = z.object({ id, name: text(60), values: z.array(text(80)).min(1, "An option needs at least one value.").max(50) }).strict();
const variant = z
  .object({
    id: z.string().regex(UUID).optional(), // a variant the product already has; without it, a new one
    values: z.record(z.string().max(80)).optional(),
    sku: z.string().trim().max(64).optional(),
    price: money.optional(),
    cost: money.optional(),
    lowAt: whole.optional(),
    opening: whole.optional(), // a new variant's first stock, written as a receipt
  })
  .strict();
const shape = {
  name: text(160),
  category: z.union([id, z.literal("")]),
  unit: id,
  image,
  onSale: z.boolean(),
  options: z.array(option).max(5),
  variants: z.array(variant).min(1, "A product needs at least one variant.").max(200),
  // A plain product, the demo's way: these go to its one variant.
  sku: z.string().trim().max(64),
  price: money,
  cost: money,
  lowAt: whole,
  opening: whole,
};
export const productCreateSchema = z.object(shape).partial().required({ name: true }).strict();
export const productUpdateSchema = z.object(shape).omit({ opening: true }).partial().strict().refine((v) => Object.keys(v).length > 0, "Nothing to change.");

/* ───── Checks ───── */

const bad = (message, code, extra) => new HttpError(400, message, { code, ...extra });

function checkLists(cfg, v, stored) {
  // What the product already has stays valid, even if the unit or category was removed since.
  if (v.unit !== undefined && v.unit !== stored?.unit && !hasId(cfg.data.units, v.unit)) throw bad("Choose a unit from the list.", "bad_unit");
  if (v.category && v.category !== stored?.category && !hasId(cfg.data.productCategories, v.category)) throw bad("Choose a category from the list.", "bad_category");
  const ids = (v.options || []).map((o) => o.id);
  if (new Set(ids).size !== ids.length) throw bad("Two options have the same id.", "bad_options");
}

/**
 * Checks the variants in use against the product's options: each one picks exactly one value of
 * every option, and no two pick the same. A product without options has exactly one variant.
 */
function checkVariants(options, variants) {
  if (!options.length) {
    if (variants.length !== 1) throw bad("A product without options has one price and one stock. Add an option to sell it in several kinds.", "variants_mismatch");
    return;
  }
  const seen = new Set();
  for (const v of variants) {
    const values = v.values || {};
    const fits = Object.keys(values).length === options.length && options.every((o) => o.values.includes(values[o.id]));
    if (!fits) throw bad("Each variant needs one value of every option.", "variants_mismatch");
    const key = options.map((o) => values[o.id]).join("\u0000");
    if (seen.has(key)) throw bad("Two variants are the same.", "variants_mismatch");
    seen.add(key);
  }
}

/** Each thing on sale has its own SKU, whatever the letter case. */
async function checkSkus(c, cfg, variants, productId) {
  const skus = variants.map((v) => (v.sku || "").toLowerCase()).filter(Boolean);
  const twice = skus.find((s, i) => skus.indexOf(s) !== i);
  if (twice) throw new HttpError(409, `SKU ${twice.toUpperCase()} is used twice.`, { code: "sku_taken", sku: twice });
  if (!skus.length) return;
  const { rows } = await c.query(
    "SELECT v.sku FROM crm_variants v WHERE v.workspace_id = $1 AND NOT v.archived AND lower(v.sku) = ANY($2::text[]) AND v.product_id IS DISTINCT FROM $3 LIMIT 1",
    [cfg.workspaceId, skus, productId || null]
  );
  if (rows[0]) throw new HttpError(409, `SKU ${rows[0].sku} is already used.`, { code: "sku_taken", sku: rows[0].sku });
}

const insertVariant = async (c, cfg, productId, v, position) =>
  (
    await c.query(
      "INSERT INTO crm_variants (workspace_id, product_id, option_values, sku, price, cost, low_at, position) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
      [cfg.workspaceId, productId, JSON.stringify(v.values || {}), v.sku || "", v.price || 0, v.cost || 0, v.lowAt || 0, position]
    )
  ).rows[0].id;

/** The changes a product write answers with: the product, and the receipts of any opening stock. */
async function answer(c, cfg, productId, moveIds = []) {
  const set = { products: await listProducts(qOf(c), cfg, [productId]) };
  const movements = await listMovements(qOf(c), cfg, { ids: moveIds });
  if (movements.length) set.movements = movements;
  return { changes: { set }, id: productId };
}

/* ───── Writes ───── */

/** A new product. Opening stock comes in as a receipt, so the ledger starts with it. */
export function createProduct(workspace, user, input) {
  return write(workspace.id, async (c, cfg) => {
    const { sku, price, cost, lowAt, opening, ...v } = input;
    v.unit ??= cfg.data.units[0]?.id || "";
    checkLists(cfg, v);
    const options = v.options || [];
    const variants = v.variants?.map(({ id: _, ...x }) => x) || [{ sku, price, cost, lowAt, opening }];
    checkVariants(options, variants);
    await checkSkus(c, cfg, variants);
    if (v.image) await checkImage(c, cfg.workspaceId, v.image);
    const { rows } = await c.query(
      "INSERT INTO crm_products (workspace_id, name, category, unit, image, on_sale, options) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      [cfg.workspaceId, v.name, v.category || "", v.unit, v.image || "", v.onSale ?? true, JSON.stringify(options)]
    );
    const productId = rows[0].id;
    const first = [];
    for (const [i, x] of variants.entries()) {
      const variantId = await insertVariant(c, cfg, productId, x, i);
      if (x.opening > 0) first.push({ variantId, type: "receipt", qty: x.opening });
    }
    return answer(c, cfg, productId, await postMoves(c, cfg, user, first, { note: OPENING }));
  });
}

/**
 * Edits a product. Stock never changes here, only through the ledger. With `variants`, the list
 * is the product's variants from now on: one with an id is changed, one without is new, and one
 * left out goes (it can't while it still has stock; if it was ever sold or stocked it is put away
 * rather than deleted, so old orders still read).
 */
export async function updateProduct(workspace, user, productId, input) {
  const { old, ...out } = await write(workspace.id, async (c, cfg) => {
    const stored = UUID.test(productId) && (await c.query("SELECT id, unit, category, options, image FROM crm_products WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [cfg.workspaceId, productId])).rows[0];
    if (!stored) throw notFound("Product not found");
    const { sku, price, cost, lowAt, variants, ...v } = input;
    checkLists(cfg, v, stored);
    if (v.image && v.image !== stored.image) await checkImage(c, cfg.workspaceId, v.image);
    const options = v.options ?? stored.options;
    const { rows: had } = await c.query("SELECT id, option_values AS values, sku FROM crm_variants WHERE workspace_id = $1 AND product_id = $2 AND NOT archived ORDER BY position, created_at, id FOR UPDATE", [cfg.workspaceId, productId]);
    const first = [];

    if (variants) {
      const unknown = variants.find((x) => x.id && !had.some((h) => h.id === x.id));
      if (unknown) throw bad("One of the variants is not this product's.", "bad_variant", { variantId: unknown.id });
      const merged = variants.map((x) => ({ ...(had.find((h) => h.id === x.id) || {}), ...x }));
      checkVariants(options, merged);
      await checkSkus(c, cfg, merged, productId);
      const gone = had.filter((h) => !variants.some((x) => x.id === h.id)).map((h) => h.id);
      if (gone.length) {
        const stock = await lockStock(c, cfg, gone);
        const full = gone.find((g) => stock[g].stock > 0 || stock[g].reserved > 0);
        if (full) throw new HttpError(409, `${stock[full].name} still has stock. Write it off or sell it first.`, { code: "variant_has_stock", variantId: full, stock: stock[full].stock, reserved: stock[full].reserved });
        const { rows: used } = await c.query(
          `SELECT v.id FROM crm_variants v WHERE v.workspace_id = $1 AND v.id = ANY($2::uuid[])
            AND (EXISTS (SELECT 1 FROM crm_stock_moves m WHERE m.workspace_id = $1 AND m.variant_id = v.id)
              OR EXISTS (SELECT 1 FROM crm_order_lines l WHERE l.workspace_id = $1 AND l.variant_id = v.id))`,
          [cfg.workspaceId, gone]
        );
        const keep = used.map((r) => r.id);
        await c.query("UPDATE crm_variants SET archived = true WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [cfg.workspaceId, keep]);
        await c.query("DELETE FROM crm_variants WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [cfg.workspaceId, gone.filter((g) => !keep.includes(g))]);
      }
      for (const [i, x] of variants.entries()) {
        if (!x.id) {
          const variantId = await insertVariant(c, cfg, productId, x, i);
          if (x.opening > 0) first.push({ variantId, type: "receipt", qty: x.opening });
          continue;
        }
        await c.query(
          `UPDATE crm_variants SET position = $3, option_values = COALESCE($4, option_values), sku = COALESCE($5, sku), price = COALESCE($6, price), cost = COALESCE($7, cost), low_at = COALESCE($8, low_at)
            WHERE workspace_id = $1 AND id = $2`,
          [cfg.workspaceId, x.id, i, x.values ? JSON.stringify(x.values) : null, x.sku ?? null, x.price ?? null, x.cost ?? null, x.lowAt ?? null]
        );
      }
    } else {
      // The options changed around variants that stayed as they were: they must still fit.
      if (v.options) checkVariants(options, had);
      if ([sku, price, cost, lowAt].some((x) => x !== undefined)) {
        if (had.length !== 1) throw bad("This product has options. Change the price, SKU and low-stock level on its variants.", "variant_required", { productId });
        if (sku !== undefined) await checkSkus(c, cfg, [{ sku }], productId);
        await c.query("UPDATE crm_variants SET sku = COALESCE($3, sku), price = COALESCE($4, price), cost = COALESCE($5, cost), low_at = COALESCE($6, low_at) WHERE workspace_id = $1 AND id = $2", [
          cfg.workspaceId,
          had[0].id,
          sku ?? null,
          price ?? null,
          cost ?? null,
          lowAt ?? null,
        ]);
      }
    }

    await c.query(
      `UPDATE crm_products SET name = COALESCE($3, name), category = COALESCE($4, category), unit = COALESCE($5, unit), image = COALESCE($6, image),
              on_sale = COALESCE($7, on_sale), options = COALESCE($8, options), updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [cfg.workspaceId, productId, v.name ?? null, v.category ?? null, v.unit ?? null, v.image ?? null, v.onSale ?? null, v.options ? JSON.stringify(v.options) : null]
    );
    const old = v.image !== undefined && v.image !== stored.image ? stored.image : "";
    return { ...(await answer(c, cfg, productId, await postMoves(c, cfg, user, first, { note: OPENING }))), old };
  });
  // A picture uploaded for this product and no longer shown by any goes too (after the commit: files are not part of it).
  await dropUpload(workspace.id, old);
  return out;
}

/**
 * Deletes a product nothing points at. One that was ever stocked or ordered stays, because the
 * ledger and the orders would lose what they are about: take it off sale instead.
 */
export async function deleteProduct(workspace, productId) {
  const out = await write(workspace.id, async (c, cfg) => {
    const stored = UUID.test(productId) && (await c.query("SELECT id, name, image FROM crm_products WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [cfg.workspaceId, productId])).rows[0];
    if (!stored) throw notFound("Product not found");
    const { rows } = await c.query(
      `SELECT (SELECT count(*)::int FROM crm_variants v JOIN crm_stock_moves m ON m.workspace_id = v.workspace_id AND m.variant_id = v.id WHERE v.workspace_id = $1 AND v.product_id = $2) AS movements,
              (SELECT count(DISTINCT l.order_id)::int FROM crm_variants v JOIN crm_order_lines l ON l.workspace_id = v.workspace_id AND l.variant_id = v.id WHERE v.workspace_id = $1 AND v.product_id = $2) AS orders,
              (SELECT COALESCE(sum(s.on_hand), 0)::float8 FROM crm_variants v JOIN crm_stock s ON s.variant_id = v.id WHERE v.workspace_id = $1 AND v.product_id = $2) AS stock`,
      [cfg.workspaceId, productId]
    );
    const uses = rows[0];
    if (uses.movements || uses.orders) {
      throw new HttpError(409, `${stored.name} has stock history or orders, so it can't be deleted. Take it off sale instead.`, { code: "product_in_use", ...uses });
    }
    await c.query("DELETE FROM crm_products WHERE workspace_id = $1 AND id = $2", [cfg.workspaceId, productId]);
    return { changes: { del: { products: [productId] } }, image: stored.image };
  });
  const { image: old, ...answerBody } = out;
  await dropUpload(workspace.id, old);
  return answerBody;
}
