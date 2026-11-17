// Products. Price, SKU and stock live on a product's variants: a plain product has one that
// nobody sees, a product with options (size, colour) has one per combination on sale.
// The app may write a plain product the demo's way (sku, price, cost, lowAt on the product itself)
// or send `variants`.
import { z } from "zod";
import { notFound } from "../../core/http.js";
import { write, isUuid, updateRow } from "../db.js";
import { bad, conflict } from "../errors.js";
import { uuid, listId as id, money, text, someKey } from "../shapes.js";
import { hasId } from "../shared/index.js";
import { storeChanges } from "./rows.js";
import { lockStock, postMoves } from "./stock.js";
import { checkImage, dropUpload } from "./images.js";

const OPENING = { en: "Opening stock", ru: "Начальный остаток", uz: "Boshlangʻich qoldiq" };

/* ───── Shapes ───── */

const whole = z.number().int().min(0).max(1_000_000);
// A picture is a path on the same site: a static one ("/products/x.jpg") or an uploaded one (see uploadImage).
const image = z.string().trim().max(300).regex(/^(\/(?!\/)[A-Za-z0-9_\-./%]*)?$/, "A picture is a path that starts with /.");
const option = z.object({ id, name: text(60), values: z.array(text(80)).min(1, "An option needs at least one value.").max(50) }).strict();
const variant = z
  .object({
    id: uuid.optional(), // a variant the product already has; without it, a new one
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
export const productUpdateSchema = z.object(shape).omit({ opening: true }).partial().strict().refine(someKey, "Nothing to change.");

/* ───── Checks ───── */

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
  if (twice) throw conflict(`SKU ${twice.toUpperCase()} is used twice.`, "sku_taken", { sku: twice });
  if (!skus.length) return;
  const { rows } = await c.query(
    "SELECT v.sku FROM crm_variants v WHERE v.workspace_id = $1 AND NOT v.archived AND lower(v.sku) = ANY($2::text[]) AND v.product_id IS DISTINCT FROM $3 LIMIT 1",
    [cfg.workspaceId, skus, productId || null]
  );
  if (rows[0]) throw conflict(`SKU ${rows[0].sku} is already used.`, "sku_taken", { sku: rows[0].sku });
}

const PRODUCT = { columns: { onSale: "on_sale" }, json: ["options"], touch: true };
/** Each variant with its place in the product's list: [{ ...variant, position }]. */
const placed = (variants) => variants.map((x, i) => ({ ...x, position: i }));

/**
 * Adds new variants to a product in one statement, and writes the opening stock of those that
 * have some as receipts. Returns the receipts' ids.
 */
async function addVariants(c, cfg, user, productId, list) {
  if (!list.length) return [];
  const col = (f) => list.map(f);
  const { rows } = await c.query(
    `INSERT INTO crm_variants (workspace_id, product_id, option_values, sku, price, cost, low_at, position)
     SELECT $1, $2, x.option_values, x.sku, x.price, x.cost, x.low_at, x.position
       FROM unnest($3::jsonb[], $4::text[], $5::bigint[], $6::bigint[], $7::int[], $8::int[]) AS x(option_values, sku, price, cost, low_at, position)
     RETURNING id, position`,
    [cfg.workspaceId, productId, col((x) => JSON.stringify(x.values || {})), col((x) => x.sku || ""), col((x) => x.price || 0), col((x) => x.cost || 0), col((x) => x.lowAt || 0), col((x) => x.position)]
  );
  const idAt = Object.fromEntries(rows.map((r) => [r.position, r.id]));
  const opening = list.filter((x) => x.opening > 0).map((x) => ({ variantId: idAt[x.position], type: "receipt", qty: x.opening }));
  return postMoves(c, cfg, user, opening, { note: OPENING });
}

/** Saves what was sent for variants the product keeps, in one statement. What isn't sent stays. */
async function saveVariants(c, cfg, list) {
  if (!list.length) return;
  const col = (f) => list.map(f);
  await c.query(
    `UPDATE crm_variants v SET position = x.position, option_values = COALESCE(x.option_values, v.option_values), sku = COALESCE(x.sku, v.sku),
            price = COALESCE(x.price, v.price), cost = COALESCE(x.cost, v.cost), low_at = COALESCE(x.low_at, v.low_at)
       FROM unnest($2::uuid[], $3::int[], $4::jsonb[], $5::text[], $6::bigint[], $7::bigint[], $8::int[]) AS x(id, position, option_values, sku, price, cost, low_at)
      WHERE v.workspace_id = $1 AND v.id = x.id`,
    [cfg.workspaceId, col((x) => x.id), col((x) => x.position), col((x) => (x.values ? JSON.stringify(x.values) : null)), col((x) => x.sku ?? null), col((x) => x.price ?? null), col((x) => x.cost ?? null), col((x) => x.lowAt ?? null)]
  );
}

/** The changes a product write answers with: the product, and the receipts of any opening stock. */
const answer = async (q, cfg, productId, moveIds) => ({ changes: await storeChanges(q, cfg, { productIds: [productId], moveIds }), id: productId });

/* ───── Writes ───── */

/** A new product. Opening stock comes in as a receipt, so the ledger starts with it. */
export function createProduct(workspace, user, input) {
  return write(workspace.id, async (c, cfg, q) => {
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
    return answer(q, cfg, productId, await addVariants(c, cfg, user, productId, placed(variants)));
  });
}

/**
 * Edits a product. Stock never changes here, only through the ledger. With `variants`, the list
 * is the product's variants from now on: one with an id is changed, one without is new, and one
 * left out goes (it can't while it still has stock; if it was ever sold or stocked it is put away
 * rather than deleted, so old orders still read).
 */
export async function updateProduct(workspace, user, productId, input) {
  const { old, ...out } = await write(workspace.id, async (c, cfg, q) => {
    const stored = isUuid(productId) && (await c.query("SELECT id, unit, category, options, image FROM crm_products WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [cfg.workspaceId, productId])).rows[0];
    if (!stored) throw notFound("Product not found");
    const { sku, price, cost, lowAt, variants, ...v } = input;
    checkLists(cfg, v, stored);
    if (v.image && v.image !== stored.image) await checkImage(c, cfg.workspaceId, v.image);
    const options = v.options ?? stored.options;
    const { rows: had } = await c.query("SELECT id, option_values AS values, sku FROM crm_variants WHERE workspace_id = $1 AND product_id = $2 AND NOT archived ORDER BY position, created_at, id FOR UPDATE", [cfg.workspaceId, productId]);
    let moveIds = [];

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
        if (full) throw conflict(`${stock[full].name} still has stock. Write it off or sell it first.`, "variant_has_stock", { variantId: full, stock: stock[full].stock, reserved: stock[full].reserved });
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
      // The ones it keeps first, so a SKU one of them gives up is free for a new one.
      const list = placed(variants);
      await saveVariants(c, cfg, list.filter((x) => x.id));
      moveIds = await addVariants(c, cfg, user, productId, list.filter((x) => !x.id));
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

    await updateRow(c, cfg, "crm_products", PRODUCT, "id", productId, v);
    const old = v.image !== undefined && v.image !== stored.image ? stored.image : "";
    return { ...(await answer(q, cfg, productId, moveIds)), old };
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
    const stored = isUuid(productId) && (await c.query("SELECT id, name, image FROM crm_products WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [cfg.workspaceId, productId])).rows[0];
    if (!stored) throw notFound("Product not found");
    const { rows } = await c.query(
      `SELECT (SELECT count(*)::int FROM crm_variants v JOIN crm_stock_moves m ON m.workspace_id = v.workspace_id AND m.variant_id = v.id WHERE v.workspace_id = $1 AND v.product_id = $2) AS movements,
              (SELECT count(DISTINCT l.order_id)::int FROM crm_variants v JOIN crm_order_lines l ON l.workspace_id = v.workspace_id AND l.variant_id = v.id WHERE v.workspace_id = $1 AND v.product_id = $2) AS orders,
              (SELECT COALESCE(sum(s.on_hand), 0)::float8 FROM crm_variants v JOIN crm_stock s ON s.variant_id = v.id WHERE v.workspace_id = $1 AND v.product_id = $2) AS stock`,
      [cfg.workspaceId, productId]
    );
    const uses = rows[0];
    if (uses.movements || uses.orders) {
      throw conflict(`${stored.name} has stock history or orders, so it can't be deleted. Take it off sale instead.`, "product_in_use", uses);
    }
    await c.query("DELETE FROM crm_products WHERE workspace_id = $1 AND id = $2", [cfg.workspaceId, productId]);
    return { changes: { del: { products: [productId] } }, image: stored.image };
  });
  const { image: old, ...answerBody } = out;
  await dropUpload(workspace.id, old);
  return answerBody;
}
