// The steps of a booking: the workspace's own list (db.apptStages), of which the code only looks
// at what a step means (its kind): pending, booked, here, done, noshow, cancelled. Which step a
// booking starts in, which it may be put into, and when a customer may still change it. Part of
// the Booking rules (booking.js re-exports it); plain functions, `now` handed in.
import { stageOf, firstOf, kindOf } from "./lists.js";
import { dayOf, addMinutes, absMin } from "./time.js";

export const CLOSED_KINDS = ["noshow", "cancelled"];
export const OPEN_KINDS = ["pending", "booked", "here"];
/** A step of this kind keeps its time: every kind except no-show and cancelled. */
export const kindHolds = (kind) => !CLOSED_KINDS.includes(kind);
export const apptKind = (db, a) => stageOf(db.apptStages, a.status).kind;
/** A booking takes its time in any step except no-show and cancelled. */
export const holdsTime = (db, a) => kindHolds(apptKind(db, a));
/** Still ahead or going on: not done, not closed. */
export const isOpen = (db, a) => OPEN_KINDS.includes(apptKind(db, a));
/** The board's main columns: every step except no-show and cancelled, in list order. */
export const flowStages = (db) => (db.apptStages || []).filter((s) => kindHolds(s.kind));
export const closedStages = (db) => (db.apptStages || []).filter((s) => !kindHolds(s.kind));

/**
 * The step a new booking starts in. One the team makes by hand is confirmed already (they have
 * spoken with the customer): the first `booked` step. One that arrives by itself (the website,
 * the AI agent) starts in the first step of the list.
 */
export function startStage(stages, by = "team") {
  const list = stages || [];
  return (by === "team" && firstOf(list, "booked")) || list[0] || null;
}

/**
 * Why a booking can't be put into this step now: a reason, or null.
 *   unknown_step  the step isn't in the list
 *   here_early    { day }   "here" only on the day of the visit, and that day hasn't come
 *   here_late     { day }   …or has passed: mark it done or missed instead
 *   done_early    { day }   a visit can be finished from its day on
 *   noshow_early  { start } missed only after the start time
 */
export function stepBlock(stages, a, stageId, now) {
  const s = (stages || []).find((x) => x.id === stageId);
  if (!s) return { code: "unknown_step", id: stageId };
  const day = dayOf(a.start);
  const today = dayOf(now);
  if (s.kind === "here" && day > today) return { code: "here_early", day };
  if (s.kind === "here" && day < today) return { code: "here_late", day };
  if (s.kind === "done" && day > today) return { code: "done_early", day };
  if (s.kind === "noshow" && a.start > now) return { code: "noshow_early", start: a.start };
  return null;
}

/**
 * Why a customer can't change their booking themselves now (move or cancel it): a reason, or null.
 *   booking_closed            it is not waiting or confirmed any more (they came, it is done, it was called off)
 *   cancel_closed { minutes } less than rules.cancelUntil before the start: only the team can change it now
 */
export function cancelProblem(stages, booking, rules, now) {
  if (!["pending", "booked"].includes(kindOf(stages, booking.status))) return { code: "booking_closed" };
  const until = rules?.cancelUntil || 0;
  if (absMin(booking.start) - absMin(now) < until) return { code: "cancel_closed", minutes: until };
  return null;
}
/** The last moment a customer can change their booking: the start less rules.cancelUntil. */
export const cancelBy = (booking, rules) => addMinutes(booking.start, -(rules?.cancelUntil || 0));
/** The step a booking goes into when it is called off. */
export const cancelledStep = (stages) => firstOf(stages, "cancelled") || null;
