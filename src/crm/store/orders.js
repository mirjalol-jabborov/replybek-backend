// Orders: making one, editing it, deleting one that left no trace. Moving an order between steps
// is in steps.js, money in payments.js. The rules are the pure functions in ../shared/store.js:
// this file loads the rows under a lock, asks the rules and writes what they allow, all in one
// transaction.
import { z } from "zod";
import { HttpError } from "../../lib/http.js";
import { write } from "../db.js";
import { customerCols } from "../core/customers.js";
import { cleanFields, firstOf, hasId, isDay, isHm, normalPhone } from "../shared/index.js";
import { K, canEditLines, checkDelivery, deliveryAllowed, planLines, requiredMissing, totals } from "../shared/store.js";
import { UUID, addPayment, historyLine, lockOrder, orderChanges } from "./rows.js";
import { hasTarget, lockStock, postMoves, refused, resolveVariants, target } from "./stock.js";

/* ───── Shapes ───── */

const uuid = z.string().regex(UUID, "This id doesn't look right.");
const listId = z.string().trim().max(40);
const money = z.number().int().min(0).max(1e12);
const line = z
  .object({
    id: z.string().optional(), // the app sends back the lines it got; a line's id means nothing here
    ...target,
    qty: z.number().int().min(0).max(1_000_000), // 0 drops the line
    price: money.optional(), // for one; the variant's price when not given
    discount: money.optional(), // off the line as a whole
  })
  .strict()
  .refine(hasTarget, "Say which product.");
const delivery = z
  .object({
    type: listId,
    address: z.string().trim().max(300),
    date: z.union([z.literal(""), z.string().refine(isDay, "Write the date like 2026-11-17.")]),
    slot: z.union([z.literal(""), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d–(([01]\d|2[0-3]):[0-5]\d|24:00)$/, "Write the window like 12:00–15:00.")]),
    time: z.union([z.literal(""), z.string().refine(isHm, "Write the time like 14:20.")]),
    fee: z.number().optional(), // ignored: the fee is the delivery method's
  })
  .partial()
  .strict();
const shape = {
  customerId: uuid,
  lines: z.array(line).min(1, "Add at least one product.").max(200),
  delivery,
  payment: listId,
  discount: money,
  source: listId,
  note: z.string().trim().max(2000),
  fields: z.record(z.unknown()),
  // Go past the workspace's own delivery rules (soft reasons). Works only when the workspace lets the team.
  force: z.boolean(),
};
export const orderCreateSchema = z
  .object({
    ...shape,
    // A customer who is not in the list yet comes with the order.
    customer: z.object({ name: z.string().trim().min(1, "Add the customer's name.").max(120), phone: z.string().trim().max(40).optional() }).strict(),
    paid: z.boolean(), // paid in full on the spot, by the order's payment method
  })
  .partial()
  .required({ lines: true })
  .strict()
  .refine((v) => Boolean(v.customerId) !== Boolean(v.customer), "An order needs one customer.");
export const orderUpdateSchema = z.object(shape).partial().strict().refine((v) => Object.keys(v).some((k) => k !== "force"), "Nothing to change.");

/* ───── Pieces ───── */

const bad = (message, code, extra) => new HttpError(400, message, { code, ...extra });
// The most an order's goods may come to, in soʻm. With the delivery fee (up to 10^9) every sum of
// an order stays a whole number JS adds up exactly (below 2^53), and so does what is paid for it.
export const MAX_ORDER = 1e15;
const conflict = (message, code, extra) => new HttpError(409, message, { code, ...extra });
/** Two flat objects hold the same values, whatever order their keys come in (JSONB keeps its own). */
const same = (a, b) => {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  return [...keys].every((k) => JSON.stringify(a?.[k]) === JSON.stringify(b?.[k]));
};
/** The same lines, in the same order, at the same prices. */
const sameLines = (a, b) => a.length === b.length && a.every((l, i) => ["variantId", "qty", "price", "discount"].every((k) => l[k] === b[i][k]));

async function customerExists(c, cfg, id) {
  const { rows } = await c.query("SELECT 1 FROM crm_customers WHERE workspace_id = $1 AND id = $2", [cfg.workspaceId, id]);
  if (!rows[0]) throw bad("Choose a customer from the list.", "bad_customer");
}

/** Checks the customer who came with a new order, the way the Customers page does: { name, phone }. */
async function newCustomer(c, cfg, { name, phone = "" }) {
  const number = phone ? normalPhone(phone) : "";
  if (number === null) throw bad("Write the number like +998 90 123 45 67.", "bad_phone");
  if (number) {
    const twin = (await c.query("SELECT id, name FROM crm_customers WHERE workspace_id = $1 AND phone = $2 AND phone <> ''", [cfg.workspaceId, number])).rows[0];
    if (twin) throw conflict(`${twin.name} already has this number.`, "phone_taken", { customerId: twin.id, customerName: twin.name });
  }
  return { name, phone: number };
}
async function addCustomer(c, cfg, { name, phone }, source) {
  const { rows } = await c.query(`INSERT INTO crm_customers (workspace_id, name, phone, source) VALUES ($1, $3, $4, $5) RETURNING ${customerCols("$2")}`, [cfg.workspaceId, cfg.timezone, name, phone, source || ""]);
  return rows[0];
}

/**
 * The delivery to store, with the reasons against it. `stored`: the order's delivery now (an edit
 * changes only what it sends). The fee is the method's, taken when the method is chosen. The
 * rules are asked only when the day or time is new: an old order can still get a new address.
 */
function cleanDelivery(cfg, sent, stored) {
  const next = { type: cfg.data.deliveryMethods[0]?.id || "", address: "", date: "", slot: "", time: "", fee: 0, ...stored, ...sent };
  // A window or an exact time, never both: naming one clears the other.
  if (sent.time && sent.slot === undefined) next.slot = "";
  if (sent.slot && sent.time === undefined) next.time = "";
  if (next.slot && next.time) throw bad("Choose a delivery window or an exact time, not both.", "bad_delivery_time");
  const method = cfg.data.deliveryMethods.find((m) => m.id === next.type);
  const newType = !stored || next.type !== stored.type;
  if (!method && newType) throw bad("Choose how the order gets to the customer.", "bad_delivery");
  next.fee = method && newType ? method.fee : Number(stored?.fee) || 0;
  const hard = [];
  if (method?.address && !next.address && (newType || next.address !== stored.address)) hard.push({ code: "address_required" });
  const moved = !stored || ["date", "slot", "time"].some((k) => next[k] !== (stored[k] || ""));
  const check = moved ? checkDelivery(next, cfg.data.settings.delivery, cfg.now) : { hard: [], soft: [] };
  return { delivery: next, hard: [...hard, ...check.hard], soft: check.soft };
}

/** The order's custom fields to store, with a reason for each required one left empty. */
function cleanOrderFields(cfg, sent, stored) {
  const defs = cfg.data.fields.order;
  const { values, errors } = cleanFields(defs, sent, stored);
  if (Object.keys(errors).length) throw bad("One of the order's fields has a value that doesn't fit it.", "bad_fields", { fields: errors });
  return { fields: values, hard: requiredMissing(defs, values) };
}

/**
 * The lines to store: [{ variantId, qty, price, discount }], with the variants locked and their
 * stock read in the order's branch. A price or discount not given is the line's old one (the line
 * in the same place, else the first with that variant), or the variant's price and none.
 * `old`: the order's lines now. A product that is off sale can stay on an order but can't be added to one.
 */
async function cleanLines(c, cfg, sent, old = [], branchId = cfg.branchId) {
  const kept = sent.filter((l) => l.qty > 0);
  if (!kept.length) throw refused([{ code: "no_lines" }]);
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

function checkDiscount(order) {
  const sums = totals({ ...order, discount: 0 });
  if ((order.discount || 0) > sums.subtotal) throw bad("A discount can't be more than the order's goods come to.", "bad_discount", { subtotal: sums.subtotal });
}

async function writeLines(c, cfg, orderId, lines) {
  await c.query("DELETE FROM crm_order_lines WHERE workspace_id = $1 AND order_id = $2", [cfg.workspaceId, orderId]);
  for (const [i, l] of lines.entries()) {
    await c.query("INSERT INTO crm_order_lines (workspace_id, order_id, variant_id, qty, price, discount, position) VALUES ($1, $2, $3, $4, $5, $6, $7)", [cfg.workspaceId, orderId, l.variantId, l.qty, l.price, l.discount, i]);
  }
}

/* ───── Create and edit ───── */

/** A new order, in the first open step: it holds nothing until it is accepted. */
export function createOrder(workspace, user, input) {
  return write(workspace.id, async (c, cfg) => {
    const stages = cfg.data.orderStages;
    const source = input.source || "";
    if (source && source !== "ai" && !hasId(cfg.data.sources, source)) throw bad("Choose where the order came from.", "bad_source");
    const payment = input.payment || cfg.data.paymentMethods[0]?.id || "";
    if (!hasId(cfg.data.paymentMethods, payment)) throw bad("Choose a payment method from the list.", "bad_payment");
    const comes = input.customerId ? await customerExists(c, cfg, input.customerId) : await newCustomer(c, cfg, input.customer);
    const d = cleanDelivery(cfg, input.delivery || {});
    const f = cleanOrderFields(cfg, input.fields || {});
    const l = await cleanLines(c, cfg, input.lines);
    const draft = { lines: l.lines, discount: input.discount || 0, delivery: d.delivery };
    checkDiscount(draft);
    const hard = [...l.hard, ...d.hard, ...f.hard];
    if (hard.length || !deliveryAllowed(d, cfg.data.settings.delivery, input.force)) throw refused(hard, d.soft);

    // A customer who came with the order is added only now, when nothing can refuse it any more.
    const customer = comes ? await addCustomer(c, cfg, comes, source === "ai" ? "" : source) : null;
    const first = firstOf(stages, K.open) || stages[0];
    const number = (await c.query("UPDATE crm_settings SET order_seq = order_seq + 1 WHERE workspace_id = $1 RETURNING order_seq", [cfg.workspaceId])).rows[0].order_seq;
    const { rows } = await c.query(
      `INSERT INTO crm_orders (workspace_id, branch_id, number, customer_id, status, delivery, payment, discount, source, note, fields, history, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [cfg.workspaceId, cfg.branchId, number, customer?.id || input.customerId, first.id, JSON.stringify(d.delivery), payment, draft.discount, source, input.note || "", JSON.stringify(f.fields), JSON.stringify([historyLine(cfg, user, "created")]), user?.id || null]
    );
    const orderId = rows[0].id;
    await writeLines(c, cfg, orderId, l.lines);
    const total = totals(draft).total;
    if (input.paid && total > 0) await addPayment(c, cfg, user, orderId, total, payment);
    return orderChanges(c, cfg, orderId, { more: customer ? { customers: [customer] } : undefined });
  });
}

/**
 * Edits an order: only what is sent changes. Items and the discount can change until the order is
 * finished or cancelled; while the order holds stock, what is held follows its items.
 */
export function updateOrder(workspace, user, id, input) {
  return write(workspace.id, async (c, cfg) => {
    const order = await lockOrder(c, cfg, id);
    const stages = cfg.data.orderStages;
    const set = {};
    const history = [];
    const hard = [];
    let soft = [];
    let plan = null;

    if (input.customerId && input.customerId !== order.customerId) {
      await customerExists(c, cfg, input.customerId);
      set.customer_id = input.customerId;
      history.push(historyLine(cfg, user, "customer"));
    }
    if (input.payment !== undefined && input.payment !== order.payment) {
      if (!hasId(cfg.data.paymentMethods, input.payment)) throw bad("Choose a payment method from the list.", "bad_payment");
      set.payment = input.payment;
      history.push(historyLine(cfg, user, "payment"));
    }
    if (input.source !== undefined && input.source !== order.source) {
      if (input.source && input.source !== "ai" && !hasId(cfg.data.sources, input.source)) throw bad("Choose where the order came from.", "bad_source");
      set.source = input.source;
    }
    if (input.note !== undefined && input.note !== order.note) {
      set.note = input.note;
      history.push(historyLine(cfg, user, "note"));
    }
    if (input.fields !== undefined) {
      const f = cleanOrderFields(cfg, input.fields, order.fields);
      if (!same(f.fields, order.fields)) {
        hard.push(...f.hard);
        set.fields = JSON.stringify(f.fields);
        history.push(historyLine(cfg, user, "fields"));
      }
    }
    let nextDelivery = order.delivery;
    if (input.delivery !== undefined) {
      const d = cleanDelivery(cfg, input.delivery, order.delivery);
      if (!same(d.delivery, order.delivery)) {
        hard.push(...d.hard);
        // A finished or cancelled order's money is settled: another method may not bring another fee.
        if (d.delivery.fee !== (Number(order.delivery.fee) || 0) && !canEditLines(stages, order)) hard.push({ code: "lines_locked" });
        soft = d.soft;
        nextDelivery = d.delivery;
        set.delivery = JSON.stringify(d.delivery);
        history.push(historyLine(cfg, user, "delivery"));
      }
    }
    let lines = order.lines;
    if (input.lines !== undefined) {
      const l = await cleanLines(c, cfg, input.lines, order.lines, order.branchId);
      if (!sameLines(l.lines, order.lines)) {
        plan = planLines({ stages, order, stock: l.stock }, l.lines);
        hard.push(...l.hard, ...(plan.ok ? [] : plan.missing));
        lines = l.lines;
        history.push(historyLine(cfg, user, "edited"));
      }
    }
    const discount = input.discount ?? order.discount;
    if (discount !== order.discount) {
      if (!canEditLines(stages, order)) hard.push({ code: "lines_locked" });
      set.discount = discount;
      history.push(historyLine(cfg, user, "discount", { amount: discount }));
    }
    if (plan || set.discount !== undefined) checkDiscount({ lines, discount, delivery: nextDelivery });
    // Each reason once: lines, the discount and the fee can all be refused as lines_locked.
    if (hard.length || !deliveryAllowed({ hard: [], soft }, cfg.data.settings.delivery, input.force)) throw refused([...new Map(hard.map((r) => [JSON.stringify(r), r])).values()], soft);

    let moveIds = [];
    if (plan) {
      await writeLines(c, cfg, order.id, plan.lines);
      moveIds = await postMoves(c, cfg, user, plan.movements, { orderId: order.id, branchId: order.branchId });
    }
    if (history.length) set.history = JSON.stringify([...order.history, ...history]);
    const cols = Object.keys(set);
    if (cols.length) await c.query(`UPDATE crm_orders SET ${cols.map((k, i) => `${k} = $${i + 3}, `).join("")}updated_at = now() WHERE workspace_id = $1 AND id = $2`, [cfg.workspaceId, order.id, ...cols.map((k) => set[k])]);
    return orderChanges(c, cfg, order.id, { variantIds: plan ? plan.movements.map((m) => m.variantId) : [], moveIds });
  });
}

/* ───── Delete ───── */

/**
 * Deletes an order that left no trace: it never held or took stock, and no money is recorded
 * against it. Any other order is cancelled instead, so the ledger and the money still add up.
 */
export function deleteOrder(workspace, id) {
  return write(workspace.id, async (c, cfg) => {
    const order = await lockOrder(c, cfg, id);
    const { rows } = await c.query("SELECT count(*)::int AS n FROM crm_stock_moves WHERE workspace_id = $1 AND order_id = $2", [cfg.workspaceId, order.id]);
    if (rows[0].n) throw conflict(`Order №${order.number} held stock, so it can't be deleted. Cancel it instead.`, "held_stock");
    if (order.payments.length) throw conflict(`Order №${order.number} has payments, so it can't be deleted. Cancel it instead.`, "has_payments");
    await c.query("DELETE FROM crm_orders WHERE workspace_id = $1 AND id = $2", [cfg.workspaceId, order.id]);
    return { changes: { del: { orders: [order.id] } } };
  });
}
