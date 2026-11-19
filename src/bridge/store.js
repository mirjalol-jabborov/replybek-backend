// The AI agent in the Store module: products on sale that can still be had (shown as cards with
// their photos), how an order can be delivered and paid, the customer's own orders, and a new
// order after they press Confirm. Delivery days and times are judged as for a customer: no reason
// against them at all, nothing forced. What is left of a thing is the Store's answer for customers
// (the same the shop page gets), and the order itself is the Store's createOrder for a customer
// acting for themselves, made with its source in one write.
import { read, write } from "../crm/db.js";
import { HttpError } from "../core/http.js";
import { mergeChanges } from "../crm/changes.js";
import * as storeModule from "../crm/store/index.js";
import { LEFT_CAP, capped, optionsText, qtyByVariant, requiredMissing, tooMany, totals } from "../crm/shared/store.js";
import { checkDelivery, dayProblem, deliveryTime, earliestToday, rulesOf, suggestDelivery, windowText, windowsFor } from "../crm/shared/delivery.js";
import { forCustomer } from "../crm/shared/customer.js";
import { kindOf, stageOf } from "../crm/shared/lists.js";
import { asCustomer, ensureCustomer, rememberItem, mineTest, capReached, capAnswer } from "./customer.js";
import { imageUrl } from "./media.js";
import { word, dayWords, moneyText, nameIn, listName } from "./wording.js";
import { id, day } from "./inputs.js";

const SHOWN = 8; // products in one answer; the customer narrows the search for more

/** A variant's options as words: "M, Red". */
const optionText = (p, v) => optionsText(p.options, v.values);
/** The variants a customer can order now: something is left of them. */
const orderable = (p) => p.variants.filter((v) => v.left > 0);

/* ───── Lookups ───── */

async function findProducts(access, args, lang) {
  return read(access.workspace.id, async (q, cfg) => {
    const words = String(args.search || "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    const { found, products } = await storeModule.findForCustomers(q, cfg, { words, limit: SHOWN });
    return {
      found,
      products: products.map((p) => {
        const variants = orderable(p);
        const low = Math.min(...variants.map((v) => v.price));
        return {
          id: p.id,
          name: p.name,
          category: listName(lang, cfg.data.productCategories, p.category),
          unit: listName(lang, cfg.data.units, p.unit),
          price: low,
          priceText: moneyText(lang, low),
          image: imageUrl(access, p.image),
          // What it is and what's in it (the team's text, cut short), and a few more photos.
          ...(p.description ? { description: p.description.length > 400 ? `${p.description.slice(0, 400).trimEnd()}…` : p.description } : {}),
          ...(p.images?.length > 1 ? { images: p.images.slice(0, 4).map((name) => imageUrl(access, name)) } : {}),
          choices: (p.options || []).map((o) => `${o.name}: ${o.values.filter((val) => variants.some((v) => v.values?.[o.id] === val)).join(", ")}`).join("; "),
          // How many are left, at most LEFT_CAP: past it, "available".
          variants: variants.map((v) => ({ variant: v.id, option: optionText(p, v), price: v.price, left: capped(v.left) })),
        };
      }),
    };
  });
}

async function orderOptions(access, args, lang) {
  return read(access.workspace.id, async (q, cfg) => {
    const rules = rulesOf(cfg.data.settings.delivery);
    const out = {
      delivery: cfg.data.deliveryMethods.map((m) => ({ method: m.id, name: nameIn(lang, m.name), needsAddress: Boolean(m.address), fee: m.fee, feeText: moneyText(lang, m.fee) })),
      payment: cfg.data.paymentMethods.map((m) => ({ payment: m.id, name: nameIn(lang, m.name) })),
      time: rules.time,
      first: suggestDelivery(rules, cfg.now, cfg.data.settings.dayStart),
    };
    if (!args.day) return out;
    const problem = dayProblem(rules, args.day, cfg.now);
    const windows = problem ? [] : windowsFor(rules, args.day, cfg.now).filter((w) => !hasReason(checkDelivery({ date: args.day, slot: windowText(w), time: "" }, rules, cfg.now)));
    const earliest = args.day === cfg.now.slice(0, 10) ? earliestToday(rules, cfg.now) : "";
    return { ...out, day: { day: args.day, problem: problem ? forCustomer(problem) : null, windows: windows.map(windowText), ...(earliest ? { earliest } : {}) } };
  });
}

const hasReason = (r) => r.hard.length > 0 || r.soft.length > 0;

async function myOrders(access, args, lang, link) {
  // A new customer, not added yet, has none.
  if (!link.customer_id) return { orders: [] };
  return read(access.workspace.id, async (q, cfg) => {
    const mine = await mineTest(q, access, link, "order");
    const orders = (await storeModule.customerHistory({ q, cfg }, link.customer_id)).orders.filter(mine).slice(0, 10);
    const products = await storeModule.listProducts(q, cfg, [...new Set(orders.flatMap((o) => o.lines.map((l) => l.productId)))]);
    const product = (id) => products.find((p) => p.id === id);
    return {
      orders: orders.map((o) => ({
        order: o.id,
        number: o.number,
        step: nameIn(lang, stageOf(cfg.data.orderStages, o.status).name),
        kind: kindOf(cfg.data.orderStages, o.status),
        total: o.totals.total,
        totalText: moneyText(lang, o.totals.total),
        paid: o.paid,
        delivery: { method: listName(lang, cfg.data.deliveryMethods, o.delivery.type), day: o.delivery.date || "", window: o.delivery.slot || "", time: o.delivery.time || "" },
        items: o.lines.map((l) => {
          const p = product(l.productId);
          const v = p?.variants.find((x) => x.id === l.variantId);
          return { name: p?.name || "", option: p && v ? optionText(p, v) : "", qty: l.qty };
        }),
        createdAt: o.createdAt,
      })),
    };
  });
}

/* ───── A new order ───── */

const WINDOW = /^([01]\d|2[0-3]):[0-5]\d\s*[-–]\s*(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

/**
 * What the customer asked for, checked against what is on sale, in stock and allowed for
 * delivery now: { lines, delivery, payment, method, products } or a refusal { error, ... }.
 */
async function draftOrder(q, cfg, args) {
  // Order fields the business requires are the team's to fill: an order can't be made without them.
  const fields = requiredMissing(cfg.data.fields.order, {});
  if (fields.length) return { error: "rules", hard: fields, soft: [] };
  const onSale = await storeModule.productsForCustomers(q, cfg, [...new Set(args.lines.map((l) => l.product))]);
  const lines = [];
  for (const asked of args.lines) {
    const p = onSale.find((x) => x.id === asked.product);
    if (!p) return { error: (await storeModule.listProducts(q, cfg, [asked.product])).length ? "off_sale" : "not_found", product: asked.product };
    const choices = orderable(p);
    const v = asked.variant ? p.variants.find((x) => x.id === asked.variant) : choices.length === 1 ? choices[0] : null;
    if (!v && !asked.variant && choices.length > 1) return { error: "variant_required", product: p.id, variants: choices.map((x) => ({ variant: x.id, option: optionText(p, x) })) };
    if (!v) return { error: "off_sale", product: p.id };
    lines.push({ productId: p.id, variantId: v.id, qty: asked.qty, price: v.price, name: p.name, option: optionText(p, v), left: v.left });
  }
  // The Store's cap on one customer order comes before the stock, so no answer tells more than LEFT_CAP.
  const [over] = tooMany(lines);
  if (over) return { error: "too_many", product: over.productId, variant: over.variantId, max: over.max };
  const need = qtyByVariant(lines);
  const short = lines.find((l) => need[l.variantId] > l.left);
  if (short) return { error: "short", product: short.productId, variant: short.variantId, left: capped(short.left) };
  const method = cfg.data.deliveryMethods.find((m) => m.id === args.delivery.method);
  if (!method) return { error: "bad_delivery" };
  const address = String(args.delivery.address || "").trim();
  if (method.address && !address) return { error: "address_required" };
  const delivery = { type: method.id, address, date: args.delivery.day || "", slot: "", time: "" };
  const rules = rulesOf(cfg.data.settings.delivery);
  if (delivery.date) {
    const w = args.delivery.window && WINDOW.exec(args.delivery.window);
    if (args.delivery.window && !w) return { error: "bad_window" };
    const at = deliveryTime(rules, { date: delivery.date, time: args.delivery.time || "", window: w ? { from: args.delivery.window.slice(0, 5), to: w[2] } : null }, cfg.now);
    if (at.problem) return { error: at.problem.code, time: rules.time };
    Object.assign(delivery, at);
    const r = checkDelivery(delivery, rules, cfg.now);
    if (hasReason(r)) return { error: "rules", hard: r.hard.map(forCustomer), soft: r.soft.map(forCustomer), first: suggestDelivery(rules, cfg.now, cfg.data.settings.dayStart) };
  }
  const payment = args.payment || cfg.data.paymentMethods[0]?.id || "";
  if (!cfg.data.paymentMethods.some((m) => m.id === payment)) return { error: "bad_payment" };
  return { lines, delivery: { ...delivery, fee: method.fee }, payment, method };
}

const order = {
  async plan(access, link, args, lang) {
    return read(access.workspace.id, async (q, cfg) => {
      const d = await draftOrder(q, cfg, args);
      if (d.error) return d;
      if (await capReached(q, cfg, link, "order")) return capAnswer();
      const sums = totals({ lines: d.lines, delivery: d.delivery });
      const when = d.delivery.date ? `, ${dayWords(lang, d.delivery.date)}${d.delivery.slot || d.delivery.time ? `, ${d.delivery.slot || d.delivery.time}` : ""}` : "";
      return {
        args: { lines: d.lines.map(({ productId, variantId, qty, price }) => ({ productId, variantId, qty, price })), delivery: d.delivery, payment: d.payment, note: args.note || "" },
        summary: {
          title: word(lang, "order"),
          lines: [
            ...d.lines.map((l) => [`${l.name}${l.option ? ` (${l.option})` : ""} × ${l.qty}`, moneyText(lang, l.qty * l.price)]),
            [word(lang, "delivery"), `${nameIn(lang, d.method.name)}${when}`],
            ...(d.delivery.address ? [[word(lang, "address"), d.delivery.address]] : []),
            ...(sums.fee ? [[word(lang, "fee"), moneyText(lang, sums.fee)]] : []),
            [word(lang, "payment"), listName(lang, cfg.data.paymentMethods, d.payment)],
          ],
          total: `${word(lang, "total")}: ${moneyText(lang, sums.total)}`,
        },
      };
    });
  },
  /**
   * One write: what was on the card is read again (the prices, the delivery fee, what is left, the
   * delivery time), then the customer is found or added and the Store's createOrder makes the
   * order for them (source "ai"), checking the customer's daily share, the delivery rules, the
   * order's fields and the stock for customers once more. Anything refused undoes it all.
   */
  apply(access, link, args) {
    const asked = { lines: args.lines.map((l) => ({ product: l.productId, variant: l.variantId, qty: l.qty })), delivery: { method: args.delivery.type, address: args.delivery.address, day: args.delivery.date, ...(args.delivery.slot ? { window: args.delivery.slot } : {}), ...(args.delivery.time ? { time: args.delivery.time } : {}) }, payment: args.payment };
    return write(access.workspace.id, async (c, cfg, q) => {
      const now = await draftOrder(q, cfg, asked);
      if (now.error) throw new HttpError(422, "The order can't be made as it stands.", { code: "rules", hard: [{ code: now.error, ...forCustomer(now) }], soft: [] });
      const changed = now.lines.filter((l, i) => l.price !== args.lines[i].price);
      if (changed.length) throw new HttpError(422, "A price changed.", { code: "rules", hard: changed.map((l) => ({ code: "price_changed", productId: l.productId, variantId: l.variantId })), soft: [] });
      if (now.delivery.fee !== args.delivery.fee) throw new HttpError(422, "The delivery fee changed.", { code: "rules", hard: [{ code: "price_changed" }], soft: [] });
      const customer = await ensureCustomer(c, cfg, access, link);
      const made = await storeModule.createOrder({ c, cfg }, asCustomer(link), {
        customerId: customer.id,
        lines: args.lines.map(({ productId, variantId, qty }) => ({ productId, variantId, qty })),
        delivery: { type: args.delivery.type, address: args.delivery.address, date: args.delivery.date, slot: args.delivery.slot, time: args.delivery.time },
        payment: args.payment,
        note: args.note,
      });
      const [row] = made.changes.set.orders;
      await rememberItem(q, access, "order", row.id);
      return { changes: mergeChanges(made.changes, customer.added && { set: { customers: [customer.added] } }), result: { order: row.id, number: row.number, total: row.totals.total } };
    });
  },
};

/* ───── The tools ───── */

export const tools = [
  {
    name: "crm_find_products",
    module: "store",
    kind: "read",
    description:
      "Products on sale that can be ordered now, with price, options and what is left (left: up to 10, past that it is simply available). They are shown to the customer as cards with photos. Ids here are what crm_place_order takes.",
    when: "The customer asks what is sold, for a product, its price, options or whether it is in stock. Search with a word or two from the product's name; leave the search out to browse.",
    input: { type: "object", properties: { search: { type: "string", maxLength: 100 } }, additionalProperties: false },
    display: { items: "products", title: "name", image: "image", subtitle: "choices", price: "priceText", id: "id" },
    run: findProducts,
  },
  {
    name: "crm_order_options",
    module: "store",
    kind: "read",
    description:
      "How an order can reach the customer and be paid: delivery methods (needsAddress, fee), payment methods, whether the business takes delivery windows or exact times (time: windows, exact, both), the first possible delivery, and for one day the windows still open (or why the day can't be used).",
    when: "Before placing an order, to offer the delivery method, the day and the time.",
    input: { type: "object", properties: { day }, additionalProperties: false },
    run: orderOptions,
  },
  {
    name: "crm_my_orders",
    module: "store",
    kind: "read",
    customer: true,
    description: "The customer's own orders, newest first: number, step, total, paid, delivery and items.",
    when: "The customer asks about their order or its status.",
    input: { type: "object", properties: {}, additionalProperties: false },
    run: myOrders,
  },
  {
    name: "crm_place_order",
    module: "store",
    kind: "write",
    customer: true,
    description:
      "Makes an order for the customer. Shows them a card to confirm; nothing is ordered before they press Confirm. Refusals are codes: variant_required (ask which option), too_many (one order takes at most max of a thing), short (left), off_sale, address_required, bad_delivery, time_required or window_required (how the business takes times), bad_window, rules (the day or time is not allowed; first is the first one that is), bad_payment, phone_limit (this phone made the day's orders already: offer to pass the request to the team). A newer card replaces the one before. On Confirm, price_changed means a price or the delivery fee changed since the card.",
    when: "The customer chose the products, how many, the delivery and the payment.",
    input: {
      type: "object",
      properties: {
        lines: { type: "array", minItems: 1, maxItems: 30, items: { type: "object", properties: { product: id, variant: { ...id, description: "The option's id, when the product has options." }, qty: { type: "integer", minimum: 1, maximum: LEFT_CAP } }, required: ["product", "qty"], additionalProperties: false } },
        delivery: {
          type: "object",
          properties: {
            method: { type: "string", maxLength: 40, description: "A method id from crm_order_options." },
            address: { type: "string", maxLength: 300 },
            day,
            window: { type: "string", description: "A window from crm_order_options, like 12:00-15:00." },
            time: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", description: "An exact time, when the business takes them." },
          },
          required: ["method"],
          additionalProperties: false,
        },
        payment: { type: "string", maxLength: 40, description: "A payment id from crm_order_options." },
        note: { type: "string", maxLength: 500 },
      },
      required: ["lines", "delivery"],
      additionalProperties: false,
    },
    op: order,
  },
];
