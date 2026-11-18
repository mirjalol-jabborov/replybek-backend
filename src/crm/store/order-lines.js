// An order's lines: which variants, how many, at what price and discount, checked with the
// variants locked and their stock read, and written in one statement. Customers' lines are their
// own kind: at the variants' prices, with no discount.
import { bad, refusal } from "../errors.js";
import { tooMany, totals } from "../shared/store.js";
import { lockStock, resolveVariants } from "./stock.js";

// The most an order's goods may come to, in soʻm. With the delivery fee (up to 10^9) every sum of
// an order stays a whole number JS adds up exactly (below 2^53), and so does what is paid for it.
const MAX_ORDER = 1e15;
/** The same lines, in the same order, at the same prices. */
export const sameLines = (a, b) => a.length === b.length && a.every((l, i) => ["variantId", "qty", "price", "discount"].every((k) => l[k] === b[i][k]));

/**
 * The lines to store: [{ variantId, qty, price, discount }], with the variants locked and their
 * stock read in the order's branch. A price or discount not given is the line's old one (the line
 * in the same place, else the first with that variant), or the variant's price and none.
 * `old`: the order's lines now. A product that is off sale can stay on an order but can't be added to one.
 */
export async function cleanLines(c, cfg, sent, old = [], branchId = cfg.branchId) {
  const kept = sent.filter((l) => l.qty > 0);
  if (!kept.length) throw refusal([{ code: "no_lines" }]);
  const ids = await resolveVariants(c, cfg, kept);
  const stock = await lockStock(c, cfg, [...ids, ...old.map((l) => l.variantId)], branchId);
  const hard = [];
  const lines = kept.map((l, i) => {
    const v = stock[ids[i]];
    const before = old[i]?.variantId === v.variantId ? old[i] : old.find((o) => o.variantId === v.variantId);
    if (!before && (!v.onSale || v.archived) && !hard.some((r) => r.variantId === v.variantId)) hard.push({ code: "off_sale", variantId: v.variantId, productId: v.productId, name: v.name });
    const out = { variantId: v.variantId, productId: v.productId, qty: l.qty, price: l.price ?? before?.price ?? v.price, discount: l.discount ?? before?.discount ?? 0 };
    if (out.discount > out.qty * out.price) throw bad("A discount can't be more than the line it is on.", "bad_discount", { variantId: v.variantId });
    return out;
  });
  if (totals({ lines }).lines > MAX_ORDER) throw bad("An order can come to 1,000,000,000,000,000 soʻm at most.", "order_too_large", { max: MAX_ORDER });
  return { lines, stock, hard };
}

/**
 * A customer's lines: at the variants' prices, with no discount, and at most LEFT_CAP of a thing
 * (tooMany), so one order can neither hold nor learn more than customers are shown is left. A
 * product this workspace doesn't have is, to a customer, simply not on sale.
 */
export async function customerLines(c, cfg, sent) {
  const lines = sent.map(({ variantId, productId, qty }) => ({ variantId, productId, qty }));
  let out;
  try {
    out = await cleanLines(c, cfg, lines);
  } catch (e) {
    if (e.extra?.code !== "missing_product") throw e;
    const asked = lines.find((x) => (e.extra.variantId ? x.variantId === e.extra.variantId : x.productId === e.extra.productId));
    throw refusal([{ code: "off_sale", variantId: asked?.variantId, productId: asked?.productId }]);
  }
  const over = tooMany(out.lines);
  if (over.length) throw refusal(over);
  return out;
}

/** The order's lines from now on, in one statement. A line's position is its place in the list. */
export async function writeLines(c, cfg, orderId, lines) {
  await c.query("DELETE FROM crm_order_lines WHERE workspace_id = $1 AND order_id = $2", [cfg.workspaceId, orderId]);
  await c.query(
    `INSERT INTO crm_order_lines (workspace_id, order_id, variant_id, qty, price, discount, position)
     SELECT $1, $2, l.variant_id, l.qty, l.price, l.discount, l.n - 1 FROM unnest($3::uuid[], $4::int[], $5::bigint[], $6::bigint[]) WITH ORDINALITY AS l(variant_id, qty, price, discount, n)`,
    [cfg.workspaceId, orderId, lines.map((l) => l.variantId), lines.map((l) => l.qty), lines.map((l) => l.price), lines.map((l) => l.discount)]
  );
}
