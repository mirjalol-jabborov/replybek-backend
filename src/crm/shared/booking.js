// The Booking module's rules. Everything here is a plain function of the workspace's data
// (db = { settings, apptStages, staff, services, timeOff, appointments }), so the server, the
// booking dialog, drag and drop on the calendar and the free-time list all ask the same question
// and get the same answer. A reason is { code, ...params }, never a sentence: the app says it in
// its own words. Nothing reads the clock: `now` ("2026-11-17T09:30") is handed in.
//
// Steps of a booking are the workspace's own list (db.apptStages); the code only looks at what a
// step means (its kind): see booking-steps.js, which this file passes on.
import { holdsTime, isOpen } from "./booking-steps.js";
import { placeOf, withinBranch, offFor } from "./branches.js";
import { dayOf, hmOf, at, toMin, fromMin, addDays, weekday, weekStart, absMin, daysBetween } from "./time.js";

export * from "./booking-steps.js";

/* ───────── Time ───────── */

export const startMin = (a) => toMin(hmOf(a.start));
export const endHm = (a) => fromMin(startMin(a) + a.duration);
/** The rules with defaults, so an older or emptier workspace still works. */
export const rulesOf = (db) => ({ minNotice: 0, maxDays: 30, cancelUntil: 0, buffer: 0, step: 15, override: true, ...(db.settings?.rules || {}) });
export const doesAll = (person, serviceIds) => (serviceIds || []).every((id) => (person.serviceIds || []).includes(id));
/** People who could do these services: active, and doing every one of them. */
export const eligible = (db, serviceIds) => (db.staff || []).filter((p) => p.active && doesAll(p, serviceIds));
/**
 * What a customer can book on their own (a public page, the AI agent): switched-on services that
 * someone switched on does, and the specialists who do at least one of them.
 */
export function customerCatalogue(db) {
  const services = (db.services || []).filter((s) => s.active && eligible(db, [s.id]).length);
  const staff = (db.staff || []).filter((p) => p.active && services.some((s) => (p.serviceIds || []).includes(s.id)));
  return { services, staff };
}

/**
 * Working hours of a person on a day, as minutes [from, to], or null on a day off. With `db`, cut
 * to their branch's own hours when it sets them (see shared/branches.js).
 */
export function hoursOn(person, day, db) {
  const h = person?.hours?.[weekday(day)];
  return h ? withinBranch([toMin(h[0]), toMin(h[1])], placeOf(db, person), day) : null;
}

/** Total duration and price of a set of services. */
export function totals(db, serviceIds) {
  const of = (id) => (db.services || []).find((s) => s.id === id);
  return (serviceIds || []).reduce((s, id) => ({ duration: s.duration + (of(id)?.duration || 0), price: s.price + (of(id)?.price || 0) }), { duration: 0, price: 0 });
}

/** Minutes kept free after a visit with these services: the largest a service sets, else the rule. */
export function bufferOf(db, serviceIds) {
  const own = (serviceIds || []).map((id) => (db.services || []).find((s) => s.id === id)?.buffer).filter((n) => n !== undefined && n !== null && n !== "");
  return own.length ? Math.max(...own.map(Number)) : rulesOf(db).buffer || 0;
}

/** A time-off entry as an absolute span [from, to). Its end is the last minute it covers ("23:59"). */
export const offSpan = (o) => [absMin(o.start), absMin(o.end) + 1];
/**
 * Time off that touches this day for this person (or for everyone), as minutes of that day [from, to).
 * Closed days count for the person's branch (`branchId`, theirs by default); with none, for everyone.
 */
export function offOn(db, staffId, day, branchId = (db.staff || []).find((p) => p.id === staffId)?.branchId) {
  const d0 = absMin(at(day, "00:00"));
  return (db.timeOff || [])
    .filter((o) => offFor(o, staffId, branchId))
    .map((o) => {
      const [a, b] = offSpan(o);
      return { o, from: Math.max(0, a - d0), to: Math.min(1440, b - d0) };
    })
    .filter((x) => x.to > x.from);
}
/** The whole business (or this branch) is closed all of this day (a holiday, a team day). Returns the entry or null. */
export function closedAllDay(db, day, branchId = null) {
  return offOn(db, null, day, branchId).find((x) => !x.o.staffId && x.from === 0 && x.to === 1440)?.o || null;
}

/* ───────── The rules engine ───────── */

/**
 * Can this visit happen? Returns { hard: [reason], soft: [reason] }.
 * hard: nobody can book it.
 *   no_staff                                  no such specialist
 *   staff_off        { staffId }              the specialist is switched off
 *   branch_closed    { branchId }             the specialist's branch is closed
 *   service_not_done { staffId, serviceId }   the specialist doesn't do this service
 *   day_passed                                a day before today
 *   bad_duration                              the end is not after the start
 *   ends_next_day                             a visit has to end on the day it starts (midnight is fine)
 *   taken            { staffId, id, from, to } another booking is there
 * soft: the business's own rules. The team may book over them when rules.override is on.
 *   time_passed                               earlier today
 *   min_notice       { minutes }              less than rules.minNotice before the start
 *   max_days         { days }                 further ahead than rules.maxDays
 *   day_off          { staffId, weekday }     the specialist (or their branch) doesn't work that weekday
 *   outside_hours    { staffId, from, to }    outside their working hours (cut to their branch's own)
 *   break            { staffId, from, to }    runs into a break
 *   away             { staffId, id, start, end, note }   the specialist's time off
 *   closed           { id, start, end, note }            the whole business (or their branch) is closed
 *   buffer_before    { minutes, until }       inside the free time kept after the visit before it
 *   buffer_after     { minutes, next }        leaves less than its own free time before the next one
 *   off_grid         { step }                 customers only: not on the start-time grid
 * A customer is offered a time only with no reasons at all.
 * draft: { staffId, serviceIds, start: "2026-11-17T14:20", duration, ignoreId }
 */
export function check(db, draft, { by = "team", now } = {}) {
  const hard = [];
  const soft = [];
  const rules = rulesOf(db);
  const person = (db.staff || []).find((p) => p.id === draft.staffId);
  if (!person) return { hard: [{ code: "no_staff" }], soft };
  const staffId = person.id;
  const day = dayOf(draft.start);
  const today = dayOf(now);
  const s = toMin(hmOf(draft.start));
  const e = s + draft.duration;
  const S = absMin(draft.start);
  const N = absMin(now);

  // Hard: nobody can do it.
  if (!person.active) hard.push({ code: "staff_off", staffId });
  const place = placeOf(db, person);
  if (place?.active === false) hard.push({ code: "branch_closed", branchId: place.id });
  const missing = (draft.serviceIds || []).find((id) => !(person.serviceIds || []).includes(id));
  if (missing) hard.push({ code: "service_not_done", staffId, serviceId: missing });
  if (day < today) hard.push({ code: "day_passed" });
  if (!(draft.duration > 0)) hard.push({ code: "bad_duration" });
  else if (e > 1440) hard.push({ code: "ends_next_day" });
  const mine = (db.appointments || []).filter((a) => a.staffId === staffId && a.id !== draft.ignoreId && dayOf(a.start) === day && holdsTime(db, a));
  const clash = mine.find((a) => s < startMin(a) + a.duration && e > startMin(a));
  if (clash) hard.push({ code: "taken", staffId, id: clash.id, from: hmOf(clash.start), to: endHm(clash) });

  // Soft: the business's rules.
  if (day === today && S < N) soft.push({ code: "time_passed" });
  else if (day >= today && rules.minNotice && S < N + rules.minNotice) soft.push({ code: "min_notice", minutes: rules.minNotice });
  if (rules.maxDays && day > addDays(today, rules.maxDays)) soft.push({ code: "max_days", days: rules.maxDays });
  const hours = hoursOn(person, day, db);
  if (!hours) soft.push({ code: "day_off", staffId, weekday: weekday(day) });
  else if (s < hours[0] || e > hours[1]) soft.push({ code: "outside_hours", staffId, from: fromMin(hours[0]), to: fromMin(hours[1]) });
  for (const b of person.breaks || []) {
    if (b.from && b.to && s < toMin(b.to) && e > toMin(b.from)) soft.push({ code: "break", staffId, from: b.from, to: b.to });
  }
  for (const o of db.timeOff || []) {
    if (!offFor(o, staffId, person.branchId)) continue;
    const [a, b] = offSpan(o);
    if (S < b && S + draft.duration > a) {
      const span = { id: o.id, start: o.start, end: o.end, note: o.note || "" };
      soft.push(o.staffId ? { code: "away", staffId, ...span } : { code: "closed", ...span });
    }
  }
  if (draft.duration > 0) {
    const own = bufferOf(db, draft.serviceIds);
    for (const a of mine) {
      const as = startMin(a);
      const ae = as + a.duration;
      const buf = bufferOf(db, a.serviceIds);
      if (ae <= s && ae + buf > s) soft.push({ code: "buffer_before", minutes: buf, until: fromMin(ae + buf) });
      if (as >= e && e + own > as) soft.push({ code: "buffer_after", minutes: own, next: hmOf(a.start) });
    }
  }
  if (by === "customer" && rules.step && s % rules.step !== 0) soft.push({ code: "off_grid", step: rules.step });
  return { hard: unique(hard), soft: unique(soft) };
}
const unique = (list) => [...new Map(list.map((r) => [JSON.stringify(r), r])).values()];
export const isClean = (r) => !r.hard.length && !r.soft.length;

/**
 * What a write does with a check: "ok", or "refused" (answer 422 with the reasons).
 * Hard reasons never pass. Soft ones pass only for the team, with force, when rules.override is on.
 */
export function verdict(db, result, { by = "team", force = false } = {}) {
  if (result.hard.length) return "refused";
  if (!result.soft.length) return "ok";
  return by === "team" && force && rulesOf(db).override ? "ok" : "refused";
}

/**
 * Who takes a visit when the team picked "anyone": the first specialist with no reasons, else the
 * first with only rule reasons, else the first who does the services. Returns { staffId, result };
 * staffId is null when nobody does all of these services.
 */
export function assign(db, draft, opts) {
  const tries = eligible(db, draft.serviceIds).map((p) => ({ staffId: p.id, result: check(db, { ...draft, staffId: p.id }, opts) }));
  return tries.find((x) => isClean(x.result)) || tries.find((x) => !x.result.hard.length) || tries[0] || { staffId: null, result: { hard: [{ code: "nobody_does" }], soft: [] } };
}

/**
 * The start times a customer would be offered on a day: [{ min, staffId }], on the `step` grid, with no
 * hard or soft reason. staffId null = anyone: each time goes to the first specialist free then.
 */
export function freeStarts(db, { staffId, serviceIds, day, duration, ignoreId }, { now } = {}) {
  if (!serviceIds?.length || !(duration > 0)) return [];
  const step = rulesOf(db).step || 15;
  const people = staffId ? eligible(db, serviceIds).filter((p) => p.id === staffId) : eligible(db, serviceIds);
  const found = new Map();
  for (const p of people) {
    const h = hoursOn(p, day, db);
    if (!h) continue;
    for (let m = Math.ceil(h[0] / step) * step; m + duration <= h[1]; m += step) {
      if (found.has(m)) continue;
      if (isClean(check(db, { staffId: p.id, serviceIds, start: at(day, fromMin(m)), duration, ignoreId }, { by: "customer", now }))) found.set(m, p.id);
    }
  }
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([min, id]) => ({ min, staffId: id }));
}

const worksOn = (db, p, day) => {
  const h = hoursOn(p, day, db);
  return Boolean(h) && !offOn(db, p.id, day).some((x) => x.from <= h[0] && x.to >= h[1]);
};

/**
 * Why a day has no free start times: one reason.
 *   no_services | day_passed | max_days { days } | nobody_does { staffId? } | branch_closed { branchId }
 *   closed { id, note } | not_working { staffId?, weekday } | too_late { minutes } | full
 */
export function whyNone(db, { staffId, serviceIds, day }, { now } = {}) {
  const rules = rulesOf(db);
  if (!serviceIds?.length) return { code: "no_services" };
  if (day < dayOf(now)) return { code: "day_passed" };
  if (rules.maxDays && day > addDays(dayOf(now), rules.maxDays)) return { code: "max_days", days: rules.maxDays };
  const people = staffId ? eligible(db, serviceIds).filter((p) => p.id === staffId) : eligible(db, serviceIds);
  if (!people.length) return staffId ? { code: "nobody_does", staffId } : { code: "nobody_does" };
  const places = people.map((p) => placeOf(db, p));
  if (places.every((b) => b?.active === false)) return { code: "branch_closed", branchId: places[0].id };
  const shut = people.map((p) => closedAllDay(db, day, p.branchId));
  if (shut.every(Boolean)) return { code: "closed", id: shut[0].id, note: shut[0].note || "" };
  const working = people.filter((p) => worksOn(db, p, day));
  if (!working.length) return people.length === 1 ? { code: "not_working", staffId: people[0].id, weekday: weekday(day) } : { code: "not_working", weekday: weekday(day) };
  if (day === dayOf(now) && rules.minNotice) {
    const latest = Math.max(...working.map((p) => hoursOn(p, day, db)[1]));
    if (absMin(at(day, "00:00")) + latest <= absMin(now) + rules.minNotice) return { code: "too_late", minutes: rules.minNotice };
  }
  return { code: "full" };
}

/**
 * Whether a day can be picked in the booking dialog: null, or { code, hard, ... }. Hard days (in
 * the past) are never offered; the others only with the team's override.
 *   day_passed | max_days { days } | closed { id, note } | not_working { staffId? }
 */
export function dayBlock(db, { staffId, serviceIds }, day, { now } = {}) {
  const rules = rulesOf(db);
  if (day < dayOf(now)) return { code: "day_passed", hard: true };
  if (rules.maxDays && day > addDays(dayOf(now), rules.maxDays)) return { code: "max_days", days: rules.maxDays, hard: false };
  const people = staffId ? (db.staff || []).filter((p) => p.id === staffId) : eligible(db, serviceIds || []);
  // Closed for everyone who could take it (the whole business, when nobody could).
  const shut = people.length ? people.map((p) => closedAllDay(db, day, p.branchId)) : [closedAllDay(db, day)];
  if (shut.every(Boolean)) return { code: "closed", id: shut[0].id, note: shut[0].note || "", hard: false };
  if (!people.length) return null;
  if (!people.some((p) => worksOn(db, p, day))) return staffId ? { code: "not_working", staffId, hard: false } : { code: "not_working", hard: false };
  return null;
}

/** Upcoming bookings that are still open (from now on). */
export const upcoming = (db, now) => (db.appointments || []).filter((a) => isOpen(db, a) && absMin(a.start) + a.duration > absMin(now));
/** Open bookings that sit inside a time-off entry, for one person or everyone. */
export function bookingsInside(db, o) {
  const [a, b] = offSpan(o);
  return (db.appointments || []).filter((x) => isOpen(db, x) && offFor(o, x.staffId, x.branchId) && absMin(x.start) < b && absMin(x.start) + x.duration > a);
}

/* ───────── Repeat bookings ───────── */

/**
 * The days of a repeat booking between two days (both included), in order.
 * series: { startDay, every (weeks), weekdays: [0..6], until: "2027-01-31" | null, count: n | null }.
 * Weeks are counted from the week (Monday first) of startDay; `count` is how many days the series
 * has in all, counted from startDay, whether or not each one could be booked.
 */
export function seriesDays(series, from, to) {
  const out = [];
  const every = Math.max(1, series.every || 1);
  const days = [...new Set(series.weekdays || [])];
  if (!days.length) return out;
  const week0 = weekStart(series.startDay);
  const last = series.until && series.until < to ? series.until : to;
  let n = 0;
  for (let day = series.startDay; day <= last; day = addDays(day, 1)) {
    if (!days.includes(weekday(day)) || Math.floor(daysBetween(week0, day) / 7) % every !== 0) continue;
    if (series.count && ++n > series.count) break;
    if (day >= from) out.push(day);
  }
  return out;
}
/** Whether a repeat booking has no days left after `day`. */
export function seriesEnded(series, day) {
  if (series.until && series.until <= day) return true;
  if (!series.count) return false;
  // Far enough to reach the last counted day whatever the pattern.
  const all = seriesDays(series, series.startDay, addDays(series.startDay, series.count * 7 * Math.max(1, series.every || 1) + 7));
  return !all.length || all[all.length - 1] <= day;
}
