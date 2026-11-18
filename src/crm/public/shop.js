// The shop page: what is on sale and how many can still be had, ordering, and looking at an
// order. The order itself is made by the Store module's createOrder() for a customer acting for
// themselves (pageCustomer): its delivery rules bind with no force, and only what can still be
// promised to a customer is offered and can be ordered (store/for-customers.js, the same answer
// the AI agent gets). One order asks for at most LEFT_CAP of a thing (checks.js), so it can
// neither hold nor learn more than the page shows.
import { read } from "../db.js";
import { bad, refusal } from "../errors.js";
import { mergeChanges } from "../changes.js";
import { createOrder, listOrders, listProducts, productsForCustomers, uploadedName, shownToCustomers, sendImage } from "../store/index.js";
import { findOrAddCustomer } from "../core/customers.js";
import { capped, lineTotal, optionsText } from "../shared/store.js";
import { rulesOf as deliveryRules, deliveryTime, windowOf } from "../shared/delivery.js";
import { stageOf } from "../shared/lists.js";
import { openPart, pageNotFound, pageWrite } from "./pages.js";
import { pageCustomer } from "./settings.js";
import { recordRequest, findRequest } from "./requests.js";

/* ───── Pictures ───── */

/** A product's picture as the page loads it: an uploaded one through this API, a static one as it is. */
function pictureOf(ws, slug, image) {
  const uploaded = uploadedName(ws.id, image);
  if (uploaded) return `/public/crm/${slug}/images/${uploaded}`;
  return image && image.startsWith("/") && !image.startsWith("/w/") ? image : "";
}

/** GET images/:name: a picture that a product on sale shows. */
export async function sendPicture(res, ws, name) {
  await read(ws.id, async (q, cfg) => void openPart(cfg, "shop"));
  if (!(await shownToCustomers(ws.id, name))) throw pageNotFound();
  await sendImage(res, ws, name);
}

/* ───── The catalogue ───── */

/** GET products: { products } on sale, each variant with whether it can be ordered and how many are left (capped). */
export function listCatalogue(ws, slug) {
  return read(ws.id, async (q, cfg) => {
    openPart(cfg, "shop");
    const unit = (id) => cfg.data.units.find((u) => u.id === id)?.name || "";
    return {
      products: (await productsForCustomers(q, cfg)).map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        unit: unit(p.unit),
        image: pictureOf(ws, slug, p.image),
        options: p.options,
        variants: p.variants.map((v) => ({ id: v.id, values: v.values, price: v.price, available: v.left > 0, left: capped(v.left) })),
      })),
    };
  });
}

/** GET categories: the product categories that have something on sale: { categories }. */
export function listCategories(ws) {
  return read(ws.id, async (q, cfg) => {
    openPart(cfg, "shop");
    const used = new Set((await productsForCustomers(q, cfg)).map((p) => p.category));
    return { categories: cfg.data.productCategories.filter((c) => used.has(c.id)).map((c) => ({ id: c.id, name: c.name })) };
  });
}

/* ───── Ordering ───── */

/**
 * POST orders: an order for a customer, found by phone or added with the order, in the first open
 * step. Which of the two never reaches the answer. The page's own choices come first (its methods,
 * how it takes times); then every refusal the Store gives, the stock last, so a request that meets
 * the stock check would really be placed and no refusal tells more about the stock than GET
 * products does. Answers { ref, token }.
 * body: { lines: [{ productId, variantId, qty }], name, phone (normalised), delivery, payment, note }.
 */
export async function placeOrder(ws, body) {
  return pageWrite(ws, async (c, cfg, q) => {
    const page = openPart(cfg, "shop");
    const method = page.deliveryMethods.find((m) => m.id === body.delivery.method);
    if (!method) throw bad("Choose how the order gets to you.", "bad_delivery");
    if (!page.paymentMethods.some((m) => m.id === body.payment)) throw bad("Choose how you pay.", "bad_payment");
    const time = deliveryTime(deliveryRules(cfg.data.settings.delivery), body.delivery, cfg.now);
    if (time.problem) throw refusal([time.problem]);
    const who = pageCustomer(cfg);
    const customer = await findOrAddCustomer(c, cfg, body, who.source);
    const made = await createOrder({ c, cfg }, who, {
      customerId: customer.id,
      lines: body.lines,
      delivery: { type: method.id, address: method.address ? body.delivery.address : "", date: body.delivery.date, slot: time.slot, time: time.time },
      payment: body.payment,
      note: body.note,
    });
    const request = await recordRequest(q, cfg, "order", { orderId: made.id });
    return { changes: mergeChanges(made.changes, customer.added && { set: { customers: [customer.added] } }), ...request };
  });
}

/** An order as its customer sees it, with the business's own names for its step and methods. */
function orderView(cfg, order, products, ref) {
  const stage = stageOf(cfg.data.orderStages, order.status);
  const nameIn = (list, id) => ({ id, name: list.find((x) => x.id === id)?.name || "" });
  const lines = order.lines.map((l) => {
    const p = products.find((x) => x.id === l.productId);
    const v = p?.variants.find((x) => x.id === l.variantId);
    const variant = optionsText(p?.options, v?.values);
    return { productId: l.productId, variantId: l.variantId, name: p?.name || "", variant, qty: l.qty, price: l.price, total: lineTotal(l) };
  });
  const d = order.delivery;
  return {
    ref,
    number: order.number,
    step: { name: stage.name, kind: stage.kind },
    lines,
    delivery: { method: nameIn(cfg.data.deliveryMethods, d.type), address: d.address || "", date: d.date || "", window: windowOf(d.slot), time: d.time || "", fee: Number(d.fee) || 0 },
    payment: nameIn(cfg.data.paymentMethods, order.payment),
    totals: { subtotal: order.totals.subtotal, discount: order.totals.discount, fee: order.totals.fee, total: order.totals.total },
    paid: order.paid,
  };
}

/** GET orders/:ref: { order }. */
export function showOrder(ws, ref, token) {
  return read(ws.id, async (q, cfg) => {
    openPart(cfg, "shop");
    const r = await findRequest(q, cfg, "order", ref, token);
    const [order] = await listOrders(q, cfg, { ids: [r.orderId] });
    if (!order) throw pageNotFound();
    const products = await listProducts(q, cfg, [...new Set(order.lines.map((l) => l.productId))]);
    return { order: orderView(cfg, order, products, r.ref) };
  });
}
