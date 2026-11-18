// The Store as customers see it, on the shop page and in a chat with the AI agent: products on
// sale, found by words, how many of each thing can still be promised, and how many orders a
// customer made themselves today.
//
// What can be promised is one answer for both places: what is on the shelf of the default
// branch, less what accepted orders hold, less what orders customers made themselves (on a page
// or through the AI agent) still ask for while they wait in an open step, for HOLD_MINUTES. So
// two customers are never promised the last item, wherever they ask. After that the hold lapses:
// the team meets any real shortage when it accepts the order.
import { wall } from "../db.js";
import { stageIds } from "../shared/index.js";
import { HOLD_MINUTES, capped, qtyByVariant } from "../shared/store.js";
import { dayOf } from "../shared/time.js";
import { listProducts } from "./rows.js";

// Every variant that is not put away, with what customers may still have of it ("left", may be
// 0 or less). $1 workspace, $2 branch, $3 the ids of the open steps.
const LEFT = `
  SELECT v.id, v.product_id, COALESCE(s.on_hand, 0) - COALESCE(s.reserved, 0) - COALESCE(w.qty, 0) AS left
    FROM crm_variants v
    LEFT JOIN crm_stock s ON s.variant_id = v.id AND s.branch_id = $2
    LEFT JOIN (SELECT l.variant_id, sum(l.qty) AS qty
                 FROM crm_orders o JOIN crm_order_lines l ON l.workspace_id = o.workspace_id AND l.order_id = o.id
                WHERE o.workspace_id = $1 AND o.customer_made AND o.status = ANY($3::text[]) AND o.created_at > now() - make_interval(mins => ${HOLD_MINUTES})
                GROUP BY l.variant_id) w ON w.variant_id = v.id
   WHERE v.workspace_id = $1 AND NOT v.archived`;
const base = (cfg) => [cfg.workspaceId, cfg.branchId, stageIds(cfg.data.orderStages, "open")];

/** How many of each variant can still be promised to a customer: { [variantId]: n }. `variantIds`: only these. */
async function leftForCustomers(q, cfg, variantIds) {
  if (variantIds && !variantIds.length) return {};
  const { rows } = await q(variantIds ? `${LEFT} AND v.id = ANY($4::uuid[])` : LEFT, variantIds ? [...base(cfg), variantIds] : base(cfg));
  return Object.fromEntries(rows.map((r) => [r.id, Number(r.left)]));
}

/**
 * The lines' variants that can't be promised in these numbers, as reasons a customer may see:
 * [{ code: "short", variantId, productId, left }] (left capped, see LEFT_CAP). `lines`: an order's
 * [{ variantId, productId, qty }].
 */
export async function shortForCustomers(q, cfg, lines) {
  const need = qtyByVariant(lines);
  const left = await leftForCustomers(q, cfg, Object.keys(need));
  return Object.entries(need)
    .filter(([id, qty]) => qty > (left[id] ?? 0))
    .map(([id]) => ({ code: "short", variantId: id, productId: lines.find((l) => l.variantId === id).productId, left: capped(left[id] ?? 0) }));
}

/**
 * Products on sale as customers see them, newest first: only variants that are not put away,
 * each with `left` (what can still be promised); a product with none of those is left out.
 * `ids`: only these.
 */
export async function productsForCustomers(q, cfg, ids) {
  const products = (await listProducts(q, cfg, ids)).filter((p) => p.onSale);
  const left = await leftForCustomers(q, cfg, ids ? products.flatMap((p) => p.variants.map((v) => v.id)) : undefined);
  return products
    .map((p) => ({ ...p, variants: p.variants.filter((v) => !v.archived).map((v) => ({ ...v, left: left[v.id] ?? 0 })) }))
    .filter((p) => p.variants.length);
}

const names = (name) => (name && typeof name === "object" ? Object.values(name) : [name]).filter(Boolean).map((n) => String(n).toLowerCase());
const like = (word) => `%${word.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/**
 * Products on sale that a customer can order now (something is left of one of them), found by
 * `words`: each word in the name, an option's name or value, a SKU or the category's name, in
 * any letter case. Answers { found: how many match, products: the newest `limit` of them, as
 * productsForCustomers gives them }. The search runs in the database, one page at a time.
 */
export async function findForCustomers(q, cfg, { words = [], limit }) {
  const params = base(cfg);
  const add = (v) => `$${params.push(v)}`;
  const match = words.map((word) => {
    const w = add(like(word));
    const categories = add(cfg.data.productCategories.filter((c) => names(c.name).some((n) => n.includes(word.toLowerCase()))).map((c) => c.id));
    return `AND (p.name ILIKE ${w} OR p.category = ANY(${categories}::text[])
      OR EXISTS (SELECT 1 FROM crm_variants v WHERE v.workspace_id = p.workspace_id AND v.product_id = p.id AND v.sku ILIKE ${w})
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(p.options) o WHERE o->>'name' ILIKE ${w} OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(o->'values') x WHERE x ILIKE ${w})))`;
  });
  const { rows } = await q(
    `WITH left_now AS (${LEFT})
     SELECT p.id, count(*) OVER ()::int AS found FROM crm_products p
      WHERE p.workspace_id = $1 AND p.on_sale AND EXISTS (SELECT 1 FROM left_now l WHERE l.product_id = p.id AND l.left > 0) ${match.join(" ")}
      ORDER BY p.created_at DESC, p.id LIMIT ${add(limit)}`,
    params
  );
  return { found: rows[0]?.found || 0, products: rows.length ? await productsForCustomers(q, cfg, rows.map((r) => r.id)) : [] };
}

/** How many orders this customer made themselves today (the business's day) that are not called off. */
export async function orderedByCustomerToday(q, cfg, customerId) {
  const { rows } = await q(
    `SELECT count(*)::int AS n FROM crm_orders
      WHERE workspace_id = $1 AND customer_id = $2 AND customer_made AND status <> ALL($3::text[]) AND ${wall("created_at", "$4")} >= $5`,
    [cfg.workspaceId, customerId, stageIds(cfg.data.orderStages, "cancelled"), cfg.timezone, `${dayOf(cfg.now)}T00:00`]
  );
  return rows[0].n;
}
