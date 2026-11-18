// What a change of a booking or an order tells the customer. Pure: the queue (queue.js) reads
// how the item was before and how it is now, and these say which message that means.
// Everything goes by a step's kind, never by a step's id.
import { kindOf } from "../shared/lists.js";

/** What notices remember of an item: just enough to see what a later write changed. */
export function stateOf(key, row, data) {
  if (key === "appointments") return { status: row.status, kind: kindOf(data.apptStages, row.status), start: row.start, staffId: row.staffId || null, customerId: row.customerId };
  return { status: row.status, kind: kindOf(data.orderStages, row.status) };
}

/**
 * Why a message must not go after all, judged against the item as the last write left it: null
 * when it is as it was when the message was written, "item_changed" when anything the message
 * depends on differs (step, time, specialist, customer), "item_gone" once it is deleted.
 * `wrote`: the state the message was written for (null for one queued before states were kept).
 */
export function staleReason(wrote, now) {
  if (!wrote) return null;
  if (!now) return "item_gone";
  return Object.keys(wrote).every((k) => (wrote[k] ?? null) === (now[k] ?? null)) ? null : "item_changed";
}

/** A booking given to another customer. A state kept before customers were remembered says nothing. */
const handedOver = (prev, next) => Boolean(prev?.customerId && next.customerId && prev.customerId !== next.customerId);

// Kinds in which the customer already knows the visit is on.
const TOLD = ["booked", "here", "done"];

/**
 * A booking's message: "booked" when it is confirmed (made in a booked step, or moved into one
 * from waiting or from closed), "moved" when a confirmed visit gets another time or specialist,
 * "cancelled" when a visit that was waiting or confirmed is called off, "booked" to a customer a
 * confirmed visit was given to. null: nothing to say.
 * A new visit of a repeat booking says nothing: the customer agreed to the series, and each
 * visit still gets its reminder.
 */
export function bookingNotice(prev, next, { seriesId = null } = {}) {
  // Given to another customer: news to the new one when it is on (the old one: formerNotice).
  if (handedOver(prev, next)) return next.kind === "booked" ? "booked" : null;
  const was = prev?.kind || null;
  if (next.kind === "booked") {
    if (was === "booked") return prev.start !== next.start || prev.staffId !== next.staffId ? "moved" : null;
    if (TOLD.includes(was)) return null;
    return was === null && seriesId ? null : "booked";
  }
  if (next.kind === "cancelled" && (was === "pending" || was === "booked")) return "cancelled";
  return null;
}

/**
 * The message to the customer a booking was taken from: "cancelled" when they were waiting for it
 * or told it is on. Sent about the visit as they knew it (its earlier time and specialist).
 */
export const formerNotice = (prev, next) => (handedOver(prev, next) && (prev.kind === "pending" || prev.kind === "booked") ? "cancelled" : null);

/** Whether a booking should have a reminder waiting: only while it is confirmed. */
export const wantsReminder = (next) => next.kind === "booked";

/**
 * An order's message: "orderCancelled" when it is called off, "orderStep" when it enters one of
 * the steps the business ticked (`steps`), a new order included. null: nothing to say.
 */
export function orderNotice(prev, next, steps) {
  if (prev && prev.status === next.status) return null;
  if (next.kind === "cancelled") return prev && prev.kind !== "cancelled" ? "orderCancelled" : null;
  return steps.includes(next.status) ? "orderStep" : null;
}

/**
 * One write can touch many items of one customer (a repeat booking moved or stopped from a day on).
 * They get one message per kind: the one about the earliest item.
 */
export function onePerCustomer(says) {
  const best = new Map();
  for (const s of says) {
    const k = `${s.customerId}:${s.kind}`;
    if (!best.has(k) || s.order < best.get(k).order) best.set(k, s);
  }
  return [...best.values()];
}
