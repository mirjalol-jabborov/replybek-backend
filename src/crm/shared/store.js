// The Store module's rules, as pure functions over demo-shaped data. The server runs them inside a
// transaction on rows it has locked and writes what the plan says; the app runs the same code for
// hints while someone types. Nothing here reads the clock (take `now`, "2026-11-17T09:30"), talks
// to a database or writes sentences: a refusal is a list of reasons { code, ...params } and the app
// puts them into words.
//
// Stock: available = stock (on hand) - reserved (held by accepted orders), counted per variant.
// What a step does to stock comes from its kind, never from its id or name:
//   open      not accepted yet: nothing held
//   reserved  accepted: its lines are held in reserve
//   done      handed over: the goods leave stock (a "sale" movement)
//   cancelled called off: whatever was held is released; a finished order becomes a return
// Stock changes only when an order crosses from one kind to another.

import { addDays, fromMin, toMin, weekday } from "./time.js";
import { kindOf } from "./lists.js";
import { missingFields } from "./fields.js";

/** The four kinds of an order step. Code compares kinds through these, never step ids. */
export const K = { open: "open", reserved: "reserved", done: "done", cancelled: "cancelled" };

/* ───── Money ───── */

const int = (n) => Math.round(Number(n) || 0);
/** One line's sum: quantity times price, less the line's own discount (whole soʻm off the line). */
export const lineTotal = (l) => int(l.qty) * int(l.price) - int(l.discount);
/**
 * What an order comes to. lines: before any discount; subtotal: after the lines' discounts;
 * discount: the order's own, never more than the subtotal; total: what the customer owes in all;
 * paid: payments so far (a refund is a minus payment); balance: what is still owed (below zero
 * when more was paid than the order now costs).
 */
export function totals(order) {
  const list = order.lines || [];
  const lines = list.reduce((s, l) => s + int(l.qty) * int(l.price), 0);
  const lineDiscounts = list.reduce((s, l) => s + int(l.discount), 0);
  const subtotal = lines - lineDiscounts;
  const discount = Math.max(0, Math.min(int(order.discount), subtotal));
  const fee = int(order.delivery?.fee);
  const total = subtotal - discount + fee;
  const paid = (order.payments || []).reduce((s, p) => s + int(p.amount), 0);
  return { lines, lineDiscounts, subtotal, discount, fee, total, paid, balance: total - paid };
}
/** Paid in full: nothing is owed any more. */
export const isPaid = (order) => totals(order).balance <= 0;
/** Lines plus fee less discounts: the sum shown everywhere an order's sum is shown. */
export const orderTotal = (order) => totals(order).total;
export const orderUnits = (order) => (order.lines || []).reduce((s, l) => s + l.qty, 0);

/* ───── Stock numbers ───── */

export const available = (p) => (p ? p.stock - p.reserved : 0);
export const isOut = (p) => available(p) <= 0;
export const isLow = (p) => available(p) <= (p.lowAt || 0);
/** "out" | "low" | "ok" */
export const stockState = (p) => (isOut(p) ? "out" : isLow(p) ? "low" : "ok");

/* ───── Steps ───── */

/** The kind of the step an order is in ("" for a step that is gone: it holds nothing). */
export const kindIn = kindOf;
/** The steps an order goes through, in list order (every step except the cancelled one). */
export const flowOf = (stages) => (stages || []).filter((s) => s.kind !== K.cancelled);
/** The step after this one, or null at the end (or when the order is finished or cancelled). */
export function nextStage(stages, status) {
  const kind = kindIn(stages, status);
  if (kind === K.done || kind === K.cancelled) return null;
  const flow = flowOf(stages);
  const i = flow.findIndex((s) => s.id === status);
  return i >= 0 ? flow[i + 1] || null : flow[0] || null;
}
/** Is an order still being worked on (not accepted yet, or accepted)? */
export const isActive = (stages, order) => [K.open, K.reserved].includes(kindIn(stages, order.status));
/** Lines can be changed until the order is finished, cancelled or returned. */
export const canEditLines = (stages, order) => isActive(stages, order) && !order.returned;

/** A step's needs apply when an order enters that step or any step after it in the list (never the cancelled one). */
export function needsFor(stages, stageId) {
  const list = stages || [];
  const at = list.findIndex((s) => s.id === stageId);
  if (at < 0 || list[at].kind === K.cancelled) return { paid: false, fields: [] };
  const before = list.slice(0, at + 1).filter((s) => s.kind !== K.cancelled);
  return { paid: before.some((s) => s.needs?.paid), fields: [...new Set(before.flatMap((s) => s.needs?.fields || []))] };
}
/**
 * What an order still lacks to enter a step, as reasons: { code: "needs_paid" } and
 * { code: "needs_field", field: id }. [] when nothing. `defs` are the workspace's order fields;
 * a field a step asks for that no longer exists is not asked for, and a yes or no field counts
 * as filled only when it says yes.
 */
export function missingFor(stages, defs, order, stageId) {
  const needs = needsFor(stages, stageId);
  const out = needs.paid && !(order.paid ?? isPaid(order)) ? [{ code: "needs_paid" }] : [];
  if (needs.fields.length) for (const def of missingFields(defs, order.fields, needs.fields)) out.push({ code: "needs_field", field: def.id });
  return out;
}
/** Fields marked required that an order has not filled in: [{ code: "field_required", field }]. */
export const requiredMissing = (defs, values) => missingFields(defs, values).map((d) => ({ code: "field_required", field: d.id }));

/* ───── Moving an order between steps ───── */

/** Quantity per variant, so an order with the same thing on two lines is counted once. */
export function qtyByVariant(lines) {
  const m = {};
  for (const l of lines || []) m[l.variantId] = (m[l.variantId] || 0) + l.qty;
  return m;
}
/**
 * Every variant in `need` ({ variantId: qty }) that hasn't that many available, as reasons
 * { code: "short", variantId, productId, name, need, free, missing }. `stock` is
 * { [variantId]: { stock, reserved, productId?, name? } }.
 */
export function shortages(stock, need) {
  const out = [];
  for (const [variantId, qty] of Object.entries(need)) {
    const row = stock?.[variantId];
    if (!row) {
      out.push({ code: "missing_product", variantId });
      continue;
    }
    const free = Math.max(0, available(row));
    if (qty > free) out.push({ code: "short", variantId, productId: row.productId, name: row.name, need: qty, free, missing: qty - free });
  }
  return out;
}
const refuse = (...missing) => ({ ok: false, missing: missing.flat() });
const entries = (need) => Object.entries(need).filter(([, qty]) => qty);
/** Goods leaving or coming back: one ledger line per order line, as the demo writes them, so the Stock page lists each line. */
const perLine = (lines, type, sign) => (lines || []).filter((l) => l.qty > 0).map((l) => ({ variantId: l.variantId, type, qty: sign * l.qty }));

/**
 * The plan for moving an order to another step.
 *   { stages, fields, order, stock }   stages: orderStages; fields: the order field definitions;
 *   order: { status, lines: [{ variantId, qty, price, discount? }], fields, paid | payments, returned };
 *   stock: { [variantId]: { stock, reserved, productId?, name? } } as it is right now.
 * Answers { ok: false, missing: [reason] } or
 *   { ok: true, change: "reserved" | "released" | "sold" | "returned" | null,
 *     order: { status, returned? },                  what changes on the order itself
 *     stock: [{ variantId, onHand, reserved }],      signed changes to the counters
 *     movements: [{ variantId, type, qty }],         ledger lines, in the order to write them
 *     pay: n,                                        soʻm still owed that handing over settles (0 = nothing)
 *     history: { text, to?, toName?, note? } }
 * Ledger types: reserve (+) and release (-) move the reserved count, one line per variant; sale (-)
 * and return (+) move what is on hand, one line per order line. A release is always written
 * before the sale it belongs to, so reserved never passes on hand on the way.
 */
export function planMove({ stages, fields, order, stock }, to, { note } = {}) {
  // Asked first, as in the demo: staying where it is changes nothing, even in a step that is gone.
  if (order.status === to) return { ok: true, change: null, order: { status: to }, stock: [], movements: [], pay: 0, history: null };
  const target = (stages || []).find((s) => s.id === to);
  if (!target) return refuse({ code: "missing_stage", stage: to });
  const from = kindIn(stages, order.status);
  const into = target.kind;
  const moved = { text: "moved", to, toName: target.name, ...(note ? { note } : {}) };
  const nothing = { ok: true, change: null, order: { status: to }, stock: [], movements: [], pay: 0, history: moved };
  if (order.returned) return refuse({ code: "returned_closed" });
  const need = qtyByVariant(order.lines);

  if (from === K.done) {
    // A finished order is closed. The one way out is back to the shelf: a return.
    if (into === K.done) return nothing;
    if (into !== K.cancelled) return refuse({ code: "done_closed" });
    return {
      ok: true,
      change: "returned",
      order: { status: to, returned: true },
      stock: entries(need).map(([variantId, qty]) => ({ variantId, onHand: qty, reserved: 0 })),
      movements: perLine(order.lines, "return", 1),
      pay: 0,
      history: { text: "returned", to, ...(note ? { note } : {}) },
    };
  }

  if (!(order.lines || []).length && into !== K.cancelled && into !== K.open) return refuse({ code: "no_lines" });
  const missing = into === K.cancelled ? [] : missingFor(stages, fields, order, to);
  const wasHeld = from === K.reserved;
  const willHold = into === K.reserved;

  if (into === K.done) {
    const short = wasHeld ? [] : shortages(stock, need);
    if (missing.length || short.length) return refuse(missing, short);
    const balance = totals(order).balance;
    return {
      ok: true,
      change: "sold",
      order: { status: to },
      stock: entries(need).map(([variantId, qty]) => ({ variantId, onHand: -qty, reserved: wasHeld ? -qty : 0 })),
      movements: [...(wasHeld ? entries(need).map(([variantId, qty]) => ({ variantId, type: "release", qty: -qty })) : []), ...perLine(order.lines, "sale", -1)],
      // Handing the goods over closes the bill, as in the demo: what is still owed counts as paid now.
      pay: order.payments ? Math.max(0, balance) : 0,
      history: moved,
    };
  }
  if (willHold && !wasHeld) {
    const short = shortages(stock, need);
    if (missing.length || short.length) return refuse(missing, short);
    return {
      ...nothing,
      change: "reserved",
      stock: entries(need).map(([variantId, qty]) => ({ variantId, onHand: 0, reserved: qty })),
      movements: entries(need).map(([variantId, qty]) => ({ variantId, type: "reserve", qty })),
    };
  }
  if (missing.length) return refuse(missing);
  if (wasHeld && !willHold) {
    return {
      ...nothing,
      change: "released",
      stock: entries(need).map(([variantId, qty]) => ({ variantId, onHand: 0, reserved: -qty })),
      movements: entries(need).map(([variantId, qty]) => ({ variantId, type: "release", qty: -qty })),
    };
  }
  return nothing; // the same kind, or between open and cancelled: stock stays as it is
}

/**
 * The plan for replacing an order's lines. While the order holds stock, the reservation follows
 * the change (refused when more is needed than is available).
 * Answers { ok: false, missing } or { ok: true, lines, stock, movements, history: { text: "edited" } }.
 */
export function planLines({ stages, order, stock }, lines) {
  if (!canEditLines(stages, order)) return refuse({ code: "lines_locked" });
  const clean = (lines || []).filter((l) => l.qty > 0);
  if (!clean.length) return refuse({ code: "no_lines" });
  const plan = { ok: true, lines: clean, stock: [], movements: [], history: { text: "edited" } };
  if (kindIn(stages, order.status) !== K.reserved) return plan;
  const before = qtyByVariant(order.lines);
  const after = qtyByVariant(clean);
  const more = {};
  for (const variantId of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const diff = (after[variantId] || 0) - (before[variantId] || 0);
    if (!diff) continue;
    if (diff > 0) more[variantId] = diff;
    plan.stock.push({ variantId, onHand: 0, reserved: diff });
    plan.movements.push({ variantId, type: diff > 0 ? "reserve" : "release", qty: diff });
  }
  const short = shortages(stock, more);
  return short.length ? refuse(short) : plan;
}

/* ───── Stock by hand ───── */

/** Goods that can't be sold leave the shelf. Not more than is available: held goods belong to orders. */
export function planWriteOff(row, qty) {
  if (!row) return refuse({ code: "missing_product" });
  if (!(qty > 0)) return refuse({ code: "qty" });
  const free = Math.max(0, available(row));
  if (qty > free) return refuse({ code: "write_off_short", variantId: row.variantId, productId: row.productId, name: row.name, free, reserved: row.reserved });
  return { ok: true, stock: [{ variantId: row.variantId, onHand: -qty, reserved: 0 }], movements: [{ variantId: row.variantId, type: "writeoff", qty: -qty }] };
}
/** A stock count: on hand becomes `counted`. It can't go below what accepted orders hold. */
export function planCount(row, counted) {
  if (!row) return refuse({ code: "missing_product" });
  if (!(counted >= 0)) return refuse({ code: "qty" });
  if (counted < row.reserved) return refuse({ code: "below_reserved", variantId: row.variantId, productId: row.productId, name: row.name, reserved: row.reserved });
  const diff = counted - row.stock;
  if (!diff) return refuse({ code: "no_difference", variantId: row.variantId, productId: row.productId, name: row.name });
  return { ok: true, diff, stock: [{ variantId: row.variantId, onHand: diff, reserved: 0 }], movements: [{ variantId: row.variantId, type: "adjust", qty: diff }] };
}

/* ───── Delivery rules (settings.delivery) ───── */

export const DELIVERY_DEFAULTS = { time: "both", windows: [], daysOff: [], closed: [], sameDayUntil: "", prepMinutes: 0, maxDays: 30, override: true };
/** The workspace's delivery rules with every key present. Takes settings.delivery. */
export const rulesOf = (delivery) => ({ ...DELIVERY_DEFAULTS, ...(delivery || {}) });
/** A window as it is kept on an order: "12:00–15:00". */
export const windowText = (w) => `${w.from}–${w.to}`;

/**
 * Why a day can't be planned, or null when it can. Only the rules about the day itself:
 * past_day (hard: nobody can plan it), closed_day { date, note }, day_off { weekday },
 * too_far { maxDays }, after_cutoff { time } (today, after the same-day cutoff).
 */
export function dayProblem(rules, day, now) {
  const nowDay = now.slice(0, 10);
  if (day < nowDay) return { code: "past_day" };
  const closed = (rules.closed || []).find((c) => c.date === day);
  if (closed) return { code: "closed_day", date: day, note: closed.note || "" };
  if ((rules.daysOff || []).includes(weekday(day))) return { code: "day_off", weekday: weekday(day) };
  if (rules.maxDays && day > addDays(nowDay, rules.maxDays)) return { code: "too_far", maxDays: rules.maxDays };
  if (day === nowDay && rules.sameDayUntil && now.slice(11, 16) > rules.sameDayUntil) return { code: "after_cutoff", time: rules.sameDayUntil };
  return null;
}
/** The windows to offer for a day: today's windows that have already ended are left out. */
export const windowsFor = (rules, day, now) => (rules.windows || []).filter((w) => day !== now.slice(0, 10) || w.to > now.slice(11, 16));
/** The earliest time an order made now can be ready today ("" when there is no preparation time). */
export const earliestToday = (rules, now) => (rules.prepMinutes ? fromMin(Math.min(24 * 60 - 1, toMin(now.slice(11, 16)) + rules.prepMinutes)) : "");

const HARD = ["past_day"];
/**
 * Checks a planned delivery against the rules: { hard: [reason], soft: [reason] }, both empty when
 * it is fine. delivery: { date, slot: "12:00–15:00" | "", time: "14:20" | "" }. An order without
 * a day is not checked. Besides the day's reasons (dayProblem): time_passed and window_ended
 * (today, already over) and too_soon { prepMinutes, earliest } (less than the preparation time
 * from now). Soft reasons are the workspace's own rules: the team may plan past them when
 * rules.override is on. Customers are never offered a day or time with any reason.
 */
export function checkDelivery(delivery, settingsDelivery, now) {
  const rules = rulesOf(settingsDelivery);
  const reasons = [];
  if (!delivery?.date) return { hard: [], soft: [] };
  const day = dayProblem(rules, delivery.date, now);
  if (day) reasons.push(day);
  const nowMin = toMin(now.slice(11, 16));
  const end = delivery.time || (delivery.slot ? delivery.slot.split("–")[1] : "");
  if (delivery.date === now.slice(0, 10) && end && !day) {
    if (toMin(end) <= nowMin) reasons.push({ code: delivery.time ? "time_passed" : "window_ended" });
    else if (rules.prepMinutes && toMin(end) - nowMin < rules.prepMinutes) reasons.push({ code: "too_soon", prepMinutes: rules.prepMinutes, earliest: earliestToday(rules, now) });
  }
  return { hard: reasons.filter((r) => HARD.includes(r.code)), soft: reasons.filter((r) => !HARD.includes(r.code)) };
}
/** May this delivery be saved? Hard reasons never pass; soft ones pass with `force` when the workspace lets the team override. */
export function deliveryAllowed(check, settingsDelivery, force) {
  if (check.hard.length) return false;
  return !check.soft.length || Boolean(force && rulesOf(settingsDelivery).override);
}

/**
 * The first delivery that keeps every rule, to start a new order with: the earliest allowed day,
 * and on it the first window (or exact time) that leaves enough time to prepare. Looks a week
 * ahead. `dayStart` is the business's opening time ("10:00" when not given).
 */
export function suggestDelivery(settingsDelivery, now, dayStart = "10:00") {
  const rules = rulesOf(settingsDelivery);
  const exact = !rules.windows.length || rules.time === "exact";
  const nowDay = now.slice(0, 10);
  const fine = (d) => {
    const c = checkDelivery(d, rules, now);
    return !c.hard.length && !c.soft.length;
  };
  for (let i = 0; i <= 7; i++) {
    const date = addDays(nowDay, i);
    if (dayProblem(rules, date, now)) continue;
    if (exact) {
      const start = date === nowDay ? toMin(earliestToday(rules, now) || now.slice(11, 16)) : toMin(dayStart);
      const time = fromMin(Math.min(23 * 60 + 55, Math.ceil(start / 5) * 5));
      if (fine({ date, time, slot: "" })) return { date, slot: "", time };
      continue;
    }
    const w = windowsFor(rules, date, now).find((x) => fine({ date, slot: windowText(x), time: "" }));
    if (w) return { date, slot: windowText(w), time: "" };
  }
  return { date: nowDay, slot: "", time: "" };
}
