// The cart in a chat: what a customer puts aside before ordering, by tapping "Add to cart" under a
// product card (with how many) or by asking the AI agent. Nothing is ordered or held by it, so a
// tap is one step and there is no card to confirm; crm_place_order without lines then orders what
// is here, with the usual Confirm, and the order takes its things out (store.js).
//
// It belongs to the conversation (crm_bridge_cart, sql/crm/50-bridge.sql), one row per variant.
// Every change is checked as an order would be (lines.js): on sale, the option chosen when there
// are several, at most LEFT_CAP of one thing, no more than is left. What the cart says when read
// is asked of the Store again, so a thing gone off sale or sold out meanwhile says so.
//
// A website with its own cart can take a card's tap itself (the widget's ReplybekCart hook); then
// the thing is in the website's cart, not here, and the chat only records the tap (crm-tools.js).
import { query } from "../core/db.js";
import { read } from "../crm/db.js";
import * as storeModule from "../crm/store/index.js";
import { LEFT_CAP, capped } from "../crm/shared/store.js";
import { optionText, resolveLines } from "./lines.js";
import { cartWords, moneyText } from "./wording.js";
import { id } from "./inputs.js";

/* ───── Storage ───── */

/** The cart's rows, oldest first: [{ product_id, variant_id, qty }]. */
export async function cartRows(access, q = query) {
  if (!access.conversationId) return [];
  const { rows } = await q("SELECT product_id, variant_id, qty FROM crm_bridge_cart WHERE workspace_id = $1 AND conversation_id = $2 ORDER BY added_at, variant_id", [access.workspace.id, access.conversationId]);
  return rows;
}

/** The rows as an order's lines: [{ product, variant, qty }]. */
export const cartAsked = (rows) => rows.map((r) => ({ product: r.product_id, variant: r.variant_id, qty: r.qty }));

/** Takes these variants out of the cart (they were ordered). `q` may be an open transaction's. */
export const takeOut = (q, access, variantIds) =>
  access.conversationId && variantIds.length
    ? q("DELETE FROM crm_bridge_cart WHERE workspace_id = $1 AND conversation_id = $2 AND variant_id = ANY($3::uuid[])", [access.workspace.id, access.conversationId, variantIds])
    : null;

const putRow = (access, line, qty) =>
  query(
    `INSERT INTO crm_bridge_cart (workspace_id, conversation_id, product_id, variant_id, qty) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workspace_id, conversation_id, variant_id) DO UPDATE SET qty = EXCLUDED.qty`,
    [access.workspace.id, access.conversationId, line.productId, line.variantId, qty]
  );

/* ───── What is in it ───── */

/**
 * The cart as the customer and the agent read it: { lines, count, total, totalText }. A line that
 * can't be ordered as it stands says why: problem "off_sale", or "short" with what is left.
 */
async function summary(q, cfg, rows, lang) {
  const ids = [...new Set(rows.map((r) => r.product_id))];
  const onSale = ids.length ? await storeModule.productsForCustomers(q, cfg, ids) : [];
  const gone = ids.length ? await storeModule.listProducts(q, cfg, ids.filter((x) => !onSale.some((p) => p.id === x))) : [];
  let total = 0;
  const lines = rows.map((r) => {
    const p = onSale.find((x) => x.id === r.product_id);
    const v = p?.variants.find((x) => x.id === r.variant_id);
    const base = { product: r.product_id, variant: r.variant_id, qty: r.qty };
    if (!v) return { ...base, name: (p || gone.find((x) => x.id === r.product_id))?.name || "", problem: "off_sale" };
    const ok = v.left >= r.qty;
    if (ok) total += v.price * r.qty;
    return { ...base, name: p.name, option: optionText(p, v), price: v.price, sumText: moneyText(lang, v.price * r.qty), ...(ok ? {} : { problem: "short", left: capped(v.left) }) };
  });
  return { lines, count: rows.reduce((n, r) => n + r.qty, 0), total, totalText: moneyText(lang, total) };
}

async function viewCart(access, args, lang) {
  const rows = await cartRows(access);
  if (!rows.length) return { lines: [], count: 0, total: 0, totalText: moneyText(lang, 0) };
  return read(access.workspace.id, (q, cfg) => summary(q, cfg, rows, lang));
}

/* ───── Changes ───── */

/**
 * Sets how many of one thing are in the cart: `want(had)` gives the new count from the count
 * there was. Checked as an order of that many would be. Answers { status, name, option, qty,
 * inCart, cart } or a refusal code with `inCart` (what the cart already has of it).
 */
async function put(access, asked, want, lang) {
  const rows = await cartRows(access);
  return read(access.workspace.id, async (q, cfg) => {
    // Which variant first (the only one, or the one named): one of it must still be had.
    const first = await resolveLines(q, cfg, [{ product: asked.product, variant: asked.variant, qty: 1 }]);
    const variantId = first.lines?.[0].variantId || first.variant;
    const had = rows.find((r) => r.variant_id === variantId)?.qty || 0;
    if (first.error) return { ...first, ...(variantId ? { inCart: had } : {}) };
    const qty = want(had);
    if (qty <= 0) {
      await takeOut(query, access, [variantId]);
      return { status: "removed", name: first.lines[0].name, option: first.lines[0].option, inCart: 0, cart: await summary(q, cfg, rows.filter((r) => r.variant_id !== variantId), lang) };
    }
    const now = await resolveLines(q, cfg, [{ product: asked.product, variant: variantId, qty }]);
    if (now.error) return { ...now, inCart: had };
    const [line] = now.lines;
    await putRow(access, line, qty);
    const after = had ? rows.map((r) => (r.variant_id === variantId ? { ...r, qty } : r)) : [...rows, { product_id: line.productId, variant_id: variantId, qty }];
    return { status: qty > had ? "added" : "changed", name: line.name, option: line.option, qty: qty - had, inCart: qty, cart: await summary(q, cfg, after, lang) };
  });
}

/** Adds `qty` of a thing to the cart. */
export const addToCart = (access, args, lang) => put(access, args, (had) => had + args.qty, lang);

/** Sets how many of a thing already in the cart; 0 takes it out. */
async function changeCart(access, args, lang) {
  const row = (await cartRows(access)).find((r) => r.variant_id === args.variant);
  if (!row) return { error: "not_in_cart", variant: args.variant };
  if (args.qty === 0) {
    await takeOut(query, access, [row.variant_id]);
    return { status: "removed", inCart: 0, cart: await viewCart(access, {}, lang) };
  }
  return put(access, { product: row.product_id, variant: row.variant_id }, () => args.qty, lang);
}

/** How many of a thing the cart has now, for a card's buttons. */
export async function inCart(access, variantId) {
  return (await cartRows(access)).find((r) => r.variant_id === variantId)?.qty || 0;
}

/** Adds or takes away `delta` of a thing (a Telegram card's + and −), from what the cart has. */
export async function stepCart(access, asked, delta, lang) {
  const had = asked.variant ? await inCart(access, asked.variant) : 0;
  if (had + delta <= 0 && asked.variant) {
    await takeOut(query, access, [asked.variant]);
    return { status: "removed", inCart: 0 };
  }
  return put(access, asked, (n) => n + delta, lang);
}

/* ───── The card's button and the tools ───── */

/**
 * The button under each product card where the agent may act in the Store: how many (1 to
 * LEFT_CAP) and "Add to cart". A product with several options has no `variant` in its inputs, so a
 * tap asks the agent to find out which one (crm-tools.js).
 */
export const CART_ACTION = { crm: true, tool: "crm_add_to_cart", args: { product: "id", variant: "cartVariant" }, quantity: "qty", max: LEFT_CAP, label: cartWords("addToCart"), done: cartWords("inCart") };

const qty = (min) => ({ type: "integer", minimum: min, maximum: LEFT_CAP });

export const tools = [
  {
    name: "crm_add_to_cart",
    module: "store",
    kind: "cart",
    conversation: true,
    description:
      "Puts a product in this chat's cart. Nothing is ordered or held, so there is no card to confirm; the customer orders the cart later with crm_place_order. A tap on a card's \"Add to cart\" does the same. Answers { status: \"added\", name, option, qty, inCart (how many of it the cart has now), cart: { lines, count, total, totalText } } or codes: variant_required (ask which option, then call again with its variant), too_many (one order takes at most max of a thing; inCart is already there), short (left), off_sale, not_found. A card the customer put in the website's own cart (the cards say so) is not in this cart: they check those out on the website.",
    when: "The customer asks to add a product to the cart, or wants several things and will order them together.",
    input: { type: "object", properties: { product: id, variant: { ...id, description: "The option's id, when the product has options." }, qty: qty(1) }, required: ["product", "qty"], additionalProperties: false },
    run: addToCart,
  },
  {
    name: "crm_cart",
    module: "store",
    kind: "cart",
    conversation: true,
    description:
      "What is in this chat's cart: lines (product, variant, name, option, qty, price, sumText; problem off_sale, or short with left, when a line can't be ordered as it is), count, total and totalText. crm_place_order without lines orders it.",
    when: "The customer asks what is in their cart, or before ordering from it.",
    input: { type: "object", properties: {}, additionalProperties: false },
    run: viewCart,
  },
  {
    name: "crm_update_cart",
    module: "store",
    kind: "cart",
    conversation: true,
    description: "Sets how many of a thing in this chat's cart there are; qty 0 takes it out. Answers as crm_add_to_cart (status changed or removed), or not_in_cart.",
    when: "The customer wants more or fewer of something in the cart, or to take it out.",
    input: { type: "object", properties: { variant: id, qty: qty(0) }, required: ["variant", "qty"], additionalProperties: false },
    run: changeCart,
  },
];
