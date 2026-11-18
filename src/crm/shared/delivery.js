// The Store module's delivery rules (settings.delivery), as pure functions: whether a day and a
// time can be planned for a delivery, and the first one that can. Nothing here reads the clock
// (take `now`, "2026-11-17T09:30"); a refusal is a list of reasons { code, ...params }.
import { addDays, fromMin, toMin, weekday } from "./time.js";

export const DELIVERY_DEFAULTS = { time: "both", windows: [], daysOff: [], closed: [], sameDayUntil: "", prepMinutes: 0, maxDays: 30, override: true };
/** The workspace's delivery rules with every key present. Takes settings.delivery. */
export const rulesOf = (delivery) => ({ ...DELIVERY_DEFAULTS, ...(delivery || {}) });
/** A window as it is kept on an order: "12:00–15:00". */
export const windowText = (w) => `${w.from}–${w.to}`;
/** An order's window "12:00–15:00" back as { from, to }, or null. */
export function windowOf(slot) {
  const [from, to] = String(slot || "").split("–");
  return from && to ? { from, to } : null;
}

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
 * How a customer chose the delivery time, checked against how the business takes them, as the
 * order keeps it: { slot, time } or { problem }. choice: { date, time?, window?: { from, to } }.
 *   time_required   the business takes exact times only
 *   window_required the business takes windows only, or a window and a time both came
 *   bad_window      not one of the windows the business offers that day (or it has ended)
 */
export function deliveryTime(rules, choice, now) {
  const mode = rules?.time || "both";
  const { time, window } = choice;
  if (time && window) return { problem: { code: "window_required" } };
  if (time) return mode === "windows" ? { problem: { code: "window_required" } } : { slot: "", time };
  if (!window) return { problem: { code: mode === "exact" ? "time_required" : "window_required" } };
  if (mode === "exact") return { problem: { code: "time_required" } };
  const offered = windowsFor(rules, choice.date, now).some((w) => w.from === window.from && w.to === window.to);
  return offered ? { slot: windowText(window), time: "" } : { problem: { code: "bad_window" } };
}

/**
 * The first delivery that keeps every rule, to start a new order with: the earliest allowed day,
 * and on it the first window (or exact time) that leaves enough time to prepare. Looks a week
 * ahead. `dayStart` is the business's opening time ("10:00" when not given). `exact`: the first
 * exact time even when the business takes windows too ("both").
 */
export function suggestDelivery(settingsDelivery, now, dayStart = "10:00", { exact: asked = false } = {}) {
  const rules = rulesOf(settingsDelivery);
  const exact = asked || !rules.windows.length || rules.time === "exact";
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
