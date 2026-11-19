// Products in a spreadsheet: one row per variant (a product without options has one), the export,
// and the plan and write of an import.
//
// A row is matched to a variant by the ID column (an export carries it), else by SKU (any letter
// case); a row that matches nothing is a new product without options. A blank cell keeps what is
// stored (an import never clears a value). Values are checked as the
// product form checks them (Store's shape, units and categories that exist, a SKU nobody else has).
// Stock is shown, but an import changes it only for a new product (its opening stock, a receipt in
// the ledger): stock of a product that exists changes by receiving goods or counting them.
import crypto from "node:crypto";
import { conflict } from "../errors.js";
import { isUuid } from "../db.js";
import { same } from "../shared/index.js";
import { optionsText } from "../shared/store.js";
import { listProducts, listMovements, postMoves, productCreateSchema, OPENING } from "../store/index.js";
import { HEADERS, header, yesNo, readYesNo } from "../shared/sheets.js";
import { given, changesOf, findInList, listName, readNumber, shapeReason } from "./cells.js";

const EXPORTED = ["product", "variant", "sku", "category", "unit", "price", "cost", "lowAt", "onSale", "stock", "reserved", "description"];
const PRODUCT_KEYS = ["name", "category", "unit", "onSale", "description"];
const VARIANT_KEYS = ["sku", "price", "cost", "lowAt"];

/** The columns an import knows. "variant" and "reserved" are read only; "stock" is read only on rows that match. */
export const productColumns = () => ["id", ...EXPORTED].map((key) => ({ key, words: HEADERS[key] }));

/** Every variant in use as a row, newest product first. */
export async function productsSheet(q, cfg, lang) {
  const rows = [];
  for (const p of await listProducts(q, cfg)) {
    for (const v of p.variants.filter((x) => !x.archived)) {
      rows.push([p.name, optionsText(p.options, v.values), v.sku, listName(cfg.data.productCategories, p.category, lang), listName(cfg.data.units, p.unit, lang), v.price, v.cost, v.lowAt, yesNo(p.onSale, lang), v.stock, v.reserved, p.description, v.id]);
    }
  }
  return { header: [...EXPORTED.map((k) => header(k, lang)), header("id", lang)], rows };
}

const shapeCheck = productCreateSchema.partial();

/** One row's cells as the product form would send them, or { skip: reason }. Blank cells send nothing. `stored`: the variant it matches. */
function sentOf(cfg, v, stored) {
  const sent = {};
  if (given(v, "product")) sent.name = v.product;
  if (given(v, "sku")) sent.sku = v.sku;
  if (given(v, "category")) {
    sent.category = findInList(cfg.data.productCategories, v.category, stored?.category);
    if (sent.category === undefined) return { skip: { code: "bad_category", value: v.category } };
  }
  if (given(v, "unit")) {
    sent.unit = findInList(cfg.data.units, v.unit, stored?.unit);
    if (sent.unit === undefined) return { skip: { code: "bad_unit", value: v.unit } };
  }
  for (const key of ["price", "cost", "lowAt"]) if (given(v, key)) sent[key] = readNumber(v[key]);
  if (given(v, "description")) sent.description = String(v.description);
  if (given(v, "onSale")) {
    sent.onSale = readYesNo(v.onSale);
    if (sent.onSale === undefined) return { skip: { code: "bad_value", column: "onSale" } };
  }
  if (!stored && given(v, "stock")) sent.opening = readNumber(v.stock);
  const shape = (stored ? shapeCheck : productCreateSchema).safeParse(sent);
  if (!shape.success) {
    // Named as the sheet names them: the product's name is the Product column, the opening stock the Stock column.
    const reason = shapeReason(shape.error);
    return { skip: reason.column ? { ...reason, column: { name: "product", opening: "stock" }[reason.column] || reason.column } : reason };
  }
  return { sent: shape.data };
}

// A variant and its product keyed as the file's columns: the product's name is the Product column.
const byColumn = ({ name, ...x }) => (name === undefined ? x : { ...x, product: name });

/**
 * What importing this table would do, against the products as they are now:
 * { add: [{ row, values }], update: [{ row, variantId, productId, name, variant: {changed}, product: {changed},
 *   changes: [{ key, from, to }], stamp }], unchanged: [row], skip: [{ row, code, ... }] }. `stamp`: when the product
 * was last changed, and the variant's own stored values (a receipt's cost and another import change
 * a variant without touching its product). Reads the variants the file names in one query.
 */
export async function planProducts(q, cfg, table) {
  const ids = [...new Set(table.rows.map((r) => r.values.id).filter(isUuid))];
  const skus = [...new Set(table.rows.map((r) => (r.values.sku || "").toLowerCase()).filter(Boolean))];
  const { rows: known } = await q(
    `SELECT v.id, v.product_id AS "productId", v.sku, v.price::float8 AS price, v.cost::float8 AS cost, v.low_at AS "lowAt",
            p.name, p.category, p.unit, p.on_sale AS "onSale", p.description,
            p.updated_at::text || ' ' || md5(row(v.sku, v.price, v.cost, v.low_at, v.option_values, v.position)::text) AS stamp
       FROM crm_variants v JOIN crm_products p ON p.workspace_id = v.workspace_id AND p.id = v.product_id
      WHERE v.workspace_id = $1 AND NOT v.archived AND (v.id = ANY($2::uuid[]) OR (lower(v.sku) = ANY($3::text[]) AND v.sku <> ''))`,
    [cfg.workspaceId, ids, skus]
  );
  const byId = new Map(known.map((x) => [x.id, x]));
  const bySku = new Map(known.filter((x) => x.sku).map((x) => [x.sku.toLowerCase(), x]));
  const plan = { add: [], update: [], unchanged: [], skip: [] };
  const seenVariant = new Map();
  const seenSku = new Map();
  const productRows = new Map(); // productId → { row, values } of the first row that set its product's fields

  for (const { n, values: v } of table.rows) {
    const skip = (reason) => plan.skip.push({ row: n, ...reason });
    let stored = null;
    if (v.id) {
      stored = byId.get(v.id);
      if (!stored) {
        skip({ code: "unknown_id" });
        continue;
      }
    }
    const sku = (v.sku || "").trim().toLowerCase();
    if (!stored && sku) stored = bySku.get(sku) || null;
    if (!stored && v.variant) {
      skip({ code: "options_new" });
      continue;
    }
    const { sent, skip: why } = sentOf(cfg, v, stored);
    if (why) {
      skip(why);
      continue;
    }
    const twin = (stored && seenVariant.get(stored.id)) || (sku && seenSku.get(sku));
    if (twin) {
      skip({ code: "duplicate", first: twin });
      continue;
    }
    const holder = sku ? bySku.get(sku) : null;
    if (holder && holder.id !== stored?.id) {
      skip({ code: "sku_taken", sku: holder.sku });
      continue;
    }
    if (!stored) {
      if (sku) seenSku.set(sku, n);
      plan.add.push({ row: n, values: { name: sent.name, category: sent.category || "", unit: sent.unit || cfg.data.units[0]?.id || "", onSale: sent.onSale ?? true, description: sent.description || "", sku: sent.sku || "", price: sent.price || 0, cost: sent.cost || 0, lowAt: sent.lowAt || 0, opening: sent.opening || 0 } });
      continue;
    }
    const product = Object.fromEntries(PRODUCT_KEYS.filter((k) => sent[k] !== undefined && !same(sent[k], stored[k])).map((k) => [k, sent[k]]));
    const variant = Object.fromEntries(VARIANT_KEYS.filter((k) => sent[k] !== undefined && !same(sent[k], stored[k])).map((k) => [k, sent[k]]));
    // Several rows of one product (its variants) must agree on the product's own fields.
    const first = productRows.get(stored.productId);
    if (first && PRODUCT_KEYS.some((k) => sent[k] !== undefined && first.values[k] !== undefined && !same(sent[k], first.values[k]))) {
      skip({ code: "product_conflict", first: first.row });
      continue;
    }
    if (!first) productRows.set(stored.productId, { row: n, values: sent });
    seenVariant.set(stored.id, n);
    if (sku) seenSku.set(sku, n);
    if (Object.keys(product).length || Object.keys(variant).length) {
      const changes = changesOf(table.columns, byColumn(stored), byColumn({ ...product, ...variant }));
      plan.update.push({ row: n, variantId: stored.id, productId: stored.productId, name: stored.name, variant, product, changes, stamp: stored.stamp });
    } else plan.unchanged.push(n);
  }
  return plan;
}

/**
 * Writes a plan: new products, their variants and opening stock (a receipt at `branchId`), then
 * every change, each in one statement.
 */
export async function applyProducts(c, cfg, q, user, plan, branchId) {
  const col = (list, f) => list.map(f);
  const adds = plan.add.map((a) => ({ ...a.values, productId: crypto.randomUUID(), variantId: crypto.randomUUID() }));
  try {
    if (adds.length) {
      await c.query(
        `INSERT INTO crm_products (id, workspace_id, name, category, unit, on_sale, description)
         SELECT x.id, $1, x.name, x.category, x.unit, x.on_sale, x.description FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::boolean[], $7::text[]) AS x(id, name, category, unit, on_sale, description)`,
        [cfg.workspaceId, col(adds, (a) => a.productId), col(adds, (a) => a.name), col(adds, (a) => a.category), col(adds, (a) => a.unit), col(adds, (a) => a.onSale), col(adds, (a) => a.description)]
      );
      await c.query(
        `INSERT INTO crm_variants (id, workspace_id, product_id, sku, price, cost, low_at)
         SELECT x.id, $1, x.product_id, x.sku, x.price, x.cost, x.low_at FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::bigint[], $6::bigint[], $7::int[]) AS x(id, product_id, sku, price, cost, low_at)`,
        [cfg.workspaceId, col(adds, (a) => a.variantId), col(adds, (a) => a.productId), col(adds, (a) => a.sku), col(adds, (a) => a.price), col(adds, (a) => a.cost), col(adds, (a) => a.lowAt)]
      );
    }
    const moveIds = await postMoves(c, cfg, user, adds.filter((a) => a.opening > 0).map((a) => ({ variantId: a.variantId, type: "receipt", qty: a.opening })), { note: OPENING, branchId });
    const variants = plan.update.filter((u) => Object.keys(u.variant).length);
    if (variants.length) {
      await c.query(
        `UPDATE crm_variants v SET sku = COALESCE(x.sku, v.sku), price = COALESCE(x.price, v.price), cost = COALESCE(x.cost, v.cost), low_at = COALESCE(x.low_at, v.low_at)
           FROM unnest($2::uuid[], $3::text[], $4::bigint[], $5::bigint[], $6::int[]) AS x(id, sku, price, cost, low_at)
          WHERE v.workspace_id = $1 AND v.id = x.id`,
        [cfg.workspaceId, col(variants, (u) => u.variantId), col(variants, (u) => u.variant.sku ?? null), col(variants, (u) => u.variant.price ?? null), col(variants, (u) => u.variant.cost ?? null), col(variants, (u) => u.variant.lowAt ?? null)]
      );
    }
    // A product's changes, once per product: its rows agree (see planProducts), but each may change
    // other fields of it (one the unit, another the sale), so they are put together.
    const byProduct = new Map();
    for (const u of plan.update) if (Object.keys(u.product).length) byProduct.set(u.productId, { ...byProduct.get(u.productId), ...u.product });
    const products = [...byProduct].map(([id, changed]) => ({ id, ...changed }));
    if (products.length) {
      await c.query(
        `UPDATE crm_products p SET name = COALESCE(x.name, p.name), category = COALESCE(x.category, p.category), unit = COALESCE(x.unit, p.unit),
                on_sale = COALESCE(x.on_sale, p.on_sale), description = COALESCE(x.description, p.description), updated_at = now()
           FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::boolean[], $7::text[]) AS x(id, name, category, unit, on_sale, description)
          WHERE p.workspace_id = $1 AND p.id = x.id`,
        [cfg.workspaceId, col(products, (u) => u.id), col(products, (u) => u.name ?? null), col(products, (u) => u.category ?? null), col(products, (u) => u.unit ?? null), col(products, (u) => u.onSale ?? null), col(products, (u) => u.description ?? null)]
      );
    }
    const touched = [...new Set([...adds.map((a) => a.productId), ...plan.update.map((u) => u.productId)])];
    const set = {};
    if (touched.length) set.products = await listProducts(q, cfg, touched);
    if (moveIds.length) set.movements = await listMovements(q, cfg, moveIds);
    return { changes: Object.keys(set).length ? { set } : {}, added: adds.length, updated: plan.update.length };
  } catch (e) {
    // Two rows that swap SKUs pass the plan and meet the database's own rule: nothing is saved.
    if (e.code === "23505") throw conflict("Two products in the file would share a SKU.", "sku_taken");
    throw e;
  }
}
