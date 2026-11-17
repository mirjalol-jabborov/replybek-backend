// The booking rules on their own: no database, no server, a fixed "now".
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  check, verdict, assign, freeStarts, whyNone, dayBlock, startStage, stepBlock, holdsTime, kindHolds, isOpen, bufferOf, totals,
  bookingsInside, upcoming, closedAllDay, seriesDays, seriesEnded, rulesOf,
} from "../src/crm/shared/booking.js";
import { addMinutes, addDays, weekday, weekStart, absMin, isMoment, nowIn, daysBetween } from "../src/crm/shared/time.js";

// Tuesday 17 November 2026, 09:00.
const NOW = "2026-11-17T09:00";
const TUE = "2026-11-17";
const WED = "2026-11-18";
const SUN = "2026-11-22";
const STAGES = [
  { id: "new", name: "New", kind: "pending" },
  { id: "ok", name: "Confirmed", kind: "booked" },
  { id: "in", name: "Here", kind: "here" },
  { id: "done", name: "Done", kind: "done" },
  { id: "miss", name: "No-show", kind: "noshow" },
  { id: "off", name: "Cancelled", kind: "cancelled" },
];
const HOURS = { 0: null, 1: ["10:00", "20:00"], 2: ["10:00", "20:00"], 3: ["10:00", "20:00"], 4: ["10:00", "20:00"], 5: ["10:00", "20:00"], 6: ["10:00", "20:00"] };
const make = (over = {}) => ({
  settings: { rules: { minNotice: 60, maxDays: 30, cancelUntil: 120, buffer: 0, step: 15, override: true, ...(over.rules || {}) } },
  apptStages: STAGES,
  staff: [
    { id: "p1", name: "Aziz", active: true, hours: HOURS, breaks: [{ from: "14:00", to: "15:00" }], serviceIds: ["s1", "s2"] },
    { id: "p2", name: "Bek", active: true, hours: HOURS, breaks: [], serviceIds: ["s1"] },
    { id: "p3", name: "Old", active: false, hours: HOURS, breaks: [], serviceIds: ["s1"] },
  ],
  services: [
    { id: "s1", duration: 30, price: 50000, active: true },
    { id: "s2", duration: 60, price: 90000, buffer: 15, active: true },
  ],
  timeOff: over.timeOff || [],
  appointments: over.appointments || [],
});
const appt = (id, start, duration = 30, over = {}) => ({ id, staffId: "p1", serviceIds: ["s1"], start, duration, status: "ok", ...over });
const draft = (start, over = {}) => ({ staffId: "p1", serviceIds: ["s1"], start, duration: 30, ...over });
const codes = (list) => list.map((r) => r.code);
const run = (db, d, opts = {}) => check(db, d, { by: "team", now: NOW, ...opts });

test("a free time inside working hours has no reasons", () => {
  const r = run(make(), draft(`${TUE}T11:00`));
  assert.deepEqual(r, { hard: [], soft: [] });
});

test("reasons are codes with their numbers, never sentences", () => {
  const r = run(make(), draft(`${TUE}T09:30`));
  assert.deepEqual(r.soft, [{ code: "min_notice", minutes: 60 }, { code: "outside_hours", staffId: "p1", from: "10:00", to: "20:00" }]);
  for (const x of [...r.hard, ...r.soft]) for (const v of Object.values(x)) assert.ok(typeof v !== "string" || !/\s/.test(v), JSON.stringify(x));
});

test("hard: no such specialist", () => {
  assert.deepEqual(run(make(), draft(`${TUE}T11:00`, { staffId: "nobody" })), { hard: [{ code: "no_staff" }], soft: [] });
});

test("hard: a specialist who is switched off, and fine when switched on", () => {
  assert.deepEqual(codes(run(make(), draft(`${TUE}T11:00`, { staffId: "p3" })).hard), ["staff_off"]);
  assert.deepEqual(run(make(), draft(`${TUE}T11:00`, { staffId: "p2" })).hard, []);
});

test("hard: a service the specialist doesn't do", () => {
  assert.deepEqual(run(make(), draft(`${TUE}T11:00`, { staffId: "p2", serviceIds: ["s1", "s2"] })).hard, [{ code: "service_not_done", staffId: "p2", serviceId: "s2" }]);
  assert.deepEqual(run(make(), draft(`${TUE}T11:00`, { staffId: "p1", serviceIds: ["s1", "s2"] })).hard, []);
});

test("hard: a day before today; today itself is not", () => {
  assert.deepEqual(codes(run(make(), draft("2026-11-16T11:00")).hard), ["day_passed"]);
  assert.ok(!codes(run(make(), draft(`${TUE}T11:00`)).hard).includes("day_passed"));
});

test("hard: the end must be after the start", () => {
  assert.deepEqual(codes(run(make(), draft(`${TUE}T11:00`, { duration: 0 })).hard), ["bad_duration"]);
  assert.deepEqual(codes(run(make(), draft(`${TUE}T11:00`, { duration: -15 })).hard), ["bad_duration"]);
});

test("day edge: a visit may end at midnight, not after it", () => {
  const late = make();
  late.staff[0].hours = { ...HOURS, 2: ["10:00", "24:00"] };
  assert.deepEqual(run(late, draft(`${TUE}T23:30`, { duration: 30 })), { hard: [], soft: [] });
  assert.deepEqual(codes(run(late, draft(`${TUE}T23:30`, { duration: 31 })).hard), ["ends_next_day"]);
});

test("hard: another booking overlaps; touching ends do not", () => {
  const db = make({ appointments: [appt("a1", `${TUE}T12:00`, 60)] });
  assert.deepEqual(run(db, draft(`${TUE}T12:30`)).hard, [{ code: "taken", staffId: "p1", id: "a1", from: "12:00", to: "13:00" }]);
  assert.deepEqual(codes(run(db, draft(`${TUE}T11:45`)).hard), ["taken"]);
  assert.deepEqual(codes(run(db, draft(`${TUE}T11:00`, { duration: 180 })).hard), ["taken"]);
  assert.deepEqual(run(db, draft(`${TUE}T11:30`)).hard, []);
  assert.deepEqual(run(db, draft(`${TUE}T13:00`)).hard, []);
  // Another specialist, another day and the booking itself don't clash.
  assert.deepEqual(run(db, draft(`${TUE}T12:30`, { staffId: "p2" })).hard, []);
  assert.deepEqual(run(db, draft(`${WED}T12:30`)).hard, []);
  assert.deepEqual(run(db, draft(`${TUE}T12:30`, { ignoreId: "a1" })).hard, []);
});

test("a time is taken in every kind except noshow and cancelled", () => {
  const want = { pending: true, booked: true, here: true, done: true, noshow: false, cancelled: false };
  for (const s of STAGES) {
    const db = make({ appointments: [appt("a1", `${TUE}T12:00`, 60, { status: s.id })] });
    assert.equal(holdsTime(db, db.appointments[0]), want[s.kind], s.kind);
    assert.equal(kindHolds(s.kind), want[s.kind]);
    assert.equal(codes(run(db, draft(`${TUE}T12:30`)).hard).includes("taken"), want[s.kind], s.kind);
  }
  const db = make({ appointments: [appt("a1", `${TUE}T12:00`, 60, { status: "done" })] });
  assert.equal(isOpen(db, db.appointments[0]), false);
});

test("soft: earlier today has passed; minimum notice otherwise", () => {
  const db = make();
  db.staff[0].hours = { ...HOURS, 2: ["06:00", "20:00"] };
  assert.deepEqual(run(db, draft(`${TUE}T08:00`)).soft, [{ code: "time_passed" }]);
  assert.deepEqual(run(db, draft(`${TUE}T09:59`)).soft, [{ code: "min_notice", minutes: 60 }]);
  assert.deepEqual(run(db, draft(`${TUE}T10:00`)).soft, []);
  assert.deepEqual(run(make({ rules: { minNotice: 0 } }), draft(`${TUE}T10:00`)).soft, []);
});

test("day edge: minimum notice crosses midnight", () => {
  const db = make({ rules: { minNotice: 1440 } });
  const now = "2026-11-17T23:00";
  assert.deepEqual(codes(check(db, draft(`${WED}T10:00`), { by: "team", now }).soft), ["min_notice"]);
  assert.deepEqual(codes(check(db, draft(`${WED}T19:30`), { by: "team", now }).soft), ["min_notice"]);
  assert.deepEqual(check(db, draft("2026-11-19T10:00"), { by: "team", now }).soft, []);
  // Two hours of notice at 23:00: 00:30 tomorrow is too soon, 01:00 is not.
  const two = make({ rules: { minNotice: 120 } });
  two.staff[0].hours = { ...HOURS, 3: ["00:00", "20:00"] };
  assert.deepEqual(codes(check(two, draft(`${WED}T00:30`), { by: "team", now }).soft), ["min_notice"]);
  assert.deepEqual(check(two, draft(`${WED}T01:00`), { by: "team", now }).soft, []);
});

test("soft: further ahead than maxDays", () => {
  const db = make({ rules: { maxDays: 7 } });
  assert.deepEqual(run(db, draft("2026-11-24T11:00")).soft, []);
  assert.deepEqual(run(db, draft("2026-11-25T11:00")).soft, [{ code: "max_days", days: 7 }]);
});

test("soft: a day off and outside working hours", () => {
  assert.deepEqual(run(make(), draft(`${SUN}T11:00`)).soft, [{ code: "day_off", staffId: "p1", weekday: 0 }]);
  assert.deepEqual(codes(run(make(), draft(`${WED}T09:45`)).soft), ["outside_hours"]);
  assert.deepEqual(codes(run(make(), draft(`${WED}T19:45`)).soft), ["outside_hours"]);
  assert.deepEqual(run(make(), draft(`${WED}T19:30`)).soft, []);
  assert.deepEqual(run(make(), draft(`${WED}T10:00`)).soft, []);
});

test("soft: a break, touching it is fine", () => {
  assert.deepEqual(run(make(), draft(`${WED}T13:45`)).soft, [{ code: "break", staffId: "p1", from: "14:00", to: "15:00" }]);
  assert.deepEqual(codes(run(make(), draft(`${WED}T14:30`)).soft), ["break"]);
  assert.deepEqual(run(make(), draft(`${WED}T13:30`)).soft, []);
  assert.deepEqual(run(make(), draft(`${WED}T15:00`)).soft, []);
  assert.deepEqual(run(make(), draft(`${WED}T14:30`, { staffId: "p2" })).soft, []);
});

test("soft: time off for one person", () => {
  const off = { id: "t1", staffId: "p1", start: `${WED}T16:00`, end: `${WED}T17:59`, note: "Training" };
  const db = make({ timeOff: [off] });
  assert.deepEqual(run(db, draft(`${WED}T16:30`)).soft, [{ code: "away", staffId: "p1", id: "t1", start: off.start, end: off.end, note: "Training" }]);
  assert.deepEqual(codes(run(db, draft(`${WED}T15:45`)).soft), ["away"]);
  assert.deepEqual(codes(run(db, draft(`${WED}T17:45`)).soft), ["away"]);
  assert.deepEqual(run(db, draft(`${WED}T15:30`)).soft, []);
  assert.deepEqual(run(db, draft(`${WED}T18:00`)).soft, []);
  assert.deepEqual(run(db, draft(`${WED}T16:30`, { staffId: "p2" })).soft, []);
});

test("soft: the whole business is closed, across days", () => {
  const off = { id: "t2", staffId: null, start: `${WED}T00:00`, end: "2026-11-19T23:59", note: "" };
  const db = make({ timeOff: [off] });
  for (const who of ["p1", "p2"]) {
    assert.deepEqual(run(db, draft(`${WED}T11:00`, { staffId: who })).soft, [{ code: "closed", id: "t2", start: off.start, end: off.end, note: "" }]);
    assert.deepEqual(codes(run(db, draft("2026-11-19T19:30", { staffId: who })).soft), ["closed"]);
    assert.deepEqual(run(db, draft("2026-11-20T11:00", { staffId: who })).soft, []);
    assert.deepEqual(run(db, draft(`${TUE}T19:30`, { staffId: who })).soft, []);
  }
  assert.equal(closedAllDay(db, WED).id, "t2");
  assert.equal(closedAllDay(db, TUE), null);
});

test("buffers: the rule's free time after the visit before, and before the next one", () => {
  const db = make({ rules: { buffer: 10 }, appointments: [appt("a1", `${WED}T12:00`, 30)] });
  assert.deepEqual(run(db, draft(`${WED}T12:30`)).soft, [{ code: "buffer_before", minutes: 10, until: "12:40" }]);
  assert.deepEqual(codes(run(db, draft(`${WED}T12:35`)).soft), ["buffer_before"]);
  assert.deepEqual(run(db, draft(`${WED}T12:40`)).soft, []);
  assert.deepEqual(run(db, draft(`${WED}T11:30`)).soft, [{ code: "buffer_after", minutes: 10, next: "12:00" }]);
  assert.deepEqual(run(db, draft(`${WED}T11:20`)).soft, []);
  // No buffer rule: back to back is fine.
  const none = make({ appointments: [appt("a1", `${WED}T12:00`, 30)] });
  assert.deepEqual(run(none, draft(`${WED}T12:30`)).soft, []);
  assert.deepEqual(run(none, draft(`${WED}T11:30`)).soft, []);
});

test("buffers: a service's own buffer wins over the rule (service.buffer ?? rules.buffer)", () => {
  // s2 keeps 15 minutes, the rule says 5.
  const db = make({ rules: { buffer: 5 }, appointments: [appt("a1", `${WED}T12:00`, 60, { serviceIds: ["s2"] })] });
  assert.equal(bufferOf(db, ["s2"]), 15);
  assert.equal(bufferOf(db, ["s1"]), 5);
  assert.equal(bufferOf(db, ["s1", "s2"]), 15);
  assert.deepEqual(run(db, draft(`${WED}T13:10`)).soft, [{ code: "buffer_before", minutes: 15, until: "13:15" }]);
  assert.deepEqual(run(db, draft(`${WED}T13:15`)).soft, []);
  // The new visit's own buffer before the next one: s1 needs 5, s2 needs 15.
  assert.deepEqual(run(db, draft(`${WED}T11:25`)).soft, []);
  assert.deepEqual(run(db, draft(`${WED}T10:50`, { serviceIds: ["s2"], duration: 60 })).soft, [{ code: "buffer_after", minutes: 15, next: "12:00" }]);
  assert.deepEqual(run(db, draft(`${WED}T10:45`, { serviceIds: ["s2"], duration: 60 })).soft, []);
  // A buffer of 0 on the service switches the rule off for it.
  db.services[0].buffer = 0;
  assert.equal(bufferOf(db, ["s1"]), 0);
});

test("a cancelled booking leaves no buffer behind", () => {
  const db = make({ rules: { buffer: 30 }, appointments: [appt("a1", `${WED}T12:00`, 30, { status: "off" })] });
  assert.deepEqual(run(db, draft(`${WED}T12:30`)), { hard: [], soft: [] });
});

test("the step grid binds customers, not the team", () => {
  const db = make();
  assert.deepEqual(check(db, draft(`${WED}T11:20`), { by: "customer", now: NOW }).soft, [{ code: "off_grid", step: 15 }]);
  assert.deepEqual(check(db, draft(`${WED}T11:15`), { by: "customer", now: NOW }).soft, []);
  assert.deepEqual(check(db, draft(`${WED}T11:20`), { by: "team", now: NOW }).soft, []);
  assert.deepEqual(check(make({ rules: { step: 20 } }), draft(`${WED}T11:20`), { by: "customer", now: NOW }).soft, []);
});

test("the override flag: soft reasons pass only for the team, with force, when override is on", () => {
  const on = make();
  const offDb = make({ rules: { override: false } });
  const softOnly = run(on, draft(`${SUN}T11:00`));
  assert.equal(verdict(on, softOnly, { by: "team", force: true }), "ok");
  assert.equal(verdict(on, softOnly, { by: "team", force: false }), "refused");
  assert.equal(verdict(offDb, softOnly, { by: "team", force: true }), "refused");
  assert.equal(verdict(on, softOnly, { by: "customer", force: true }), "refused");
  const hardToo = run(make({ appointments: [appt("a1", `${WED}T12:00`, 60)] }), draft(`${WED}T12:30`));
  assert.equal(verdict(on, hardToo, { by: "team", force: true }), "refused");
  assert.equal(verdict(on, { hard: [], soft: [] }, {}), "ok");
  // Rules missing from an older workspace: the defaults, override on.
  assert.equal(rulesOf({}).override, true);
});

test("free times: on the grid, inside hours, around breaks, bookings and notice", () => {
  const db = make({ appointments: [appt("a1", `${WED}T10:00`, 60)] });
  const mins = freeStarts(db, { staffId: "p1", serviceIds: ["s1"], day: WED, duration: 30 }, { now: NOW }).map((x) => x.min);
  assert.equal(mins[0], 660); // 11:00, after the booking
  assert.ok(mins.includes(13 * 60 + 30) && !mins.includes(13 * 60 + 45) && !mins.includes(14 * 60) && mins.includes(15 * 60));
  assert.equal(mins.at(-1), 19 * 60 + 30);
  assert.ok(mins.every((m) => m % 15 === 0));
  // Today at 09:00 with an hour of notice: the first time is 10:00.
  assert.equal(freeStarts(db, { staffId: "p1", serviceIds: ["s1"], day: TUE, duration: 30 }, { now: NOW })[0].min, 600);
  assert.equal(freeStarts(db, { staffId: "p1", serviceIds: ["s1"], day: TUE, duration: 30 }, { now: "2026-11-17T12:10" })[0].min, 13 * 60 + 15);
});

test("free times: anyone gives each time to the first specialist free then", () => {
  const db = make({ appointments: [appt("a1", `${WED}T10:00`, 60)] });
  const list = freeStarts(db, { staffId: null, serviceIds: ["s1"], day: WED, duration: 30 }, { now: NOW });
  assert.deepEqual(list[0], { min: 600, staffId: "p2" });
  assert.equal(list.find((x) => x.min === 660).staffId, "p1");
  assert.equal(list.find((x) => x.min === 14 * 60).staffId, "p2"); // p1 is on a break
  // Only p1 does s2; a switched-off specialist is never offered.
  assert.ok(freeStarts(db, { staffId: null, serviceIds: ["s2"], day: WED, duration: 60 }, { now: NOW }).every((x) => x.staffId === "p1"));
  assert.deepEqual(freeStarts(db, { staffId: "p3", serviceIds: ["s1"], day: WED, duration: 30 }, { now: NOW }), []);
  assert.deepEqual(freeStarts(db, { staffId: "p2", serviceIds: ["s2"], day: WED, duration: 60 }, { now: NOW }), []);
  assert.deepEqual(freeStarts(db, { staffId: null, serviceIds: [], day: WED, duration: 30 }, { now: NOW }), []);
});

test("free times: a booking being moved doesn't block itself", () => {
  const db = make({ appointments: [appt("a1", `${WED}T10:00`, 60)] });
  assert.equal(freeStarts(db, { staffId: "p1", serviceIds: ["s1"], day: WED, duration: 30, ignoreId: "a1" }, { now: NOW })[0].min, 600);
});

test("why a day has no free times", () => {
  const q = (db, over = {}, now = NOW) => whyNone(db, { staffId: null, serviceIds: ["s1"], day: WED, ...over }, { now });
  assert.deepEqual(q(make(), { serviceIds: [] }), { code: "no_services" });
  assert.deepEqual(q(make(), { day: "2026-11-16" }), { code: "day_passed" });
  assert.deepEqual(q(make({ rules: { maxDays: 7 } }), { day: "2026-11-30" }), { code: "max_days", days: 7 });
  assert.deepEqual(q(make(), { staffId: "p2", serviceIds: ["s2"] }), { code: "nobody_does", staffId: "p2" });
  assert.deepEqual(q(make({ timeOff: [{ id: "t", staffId: null, start: `${WED}T00:00`, end: `${WED}T23:59`, note: "Holiday" }] })), { code: "closed", id: "t", note: "Holiday" });
  assert.deepEqual(q(make(), { day: SUN }), { code: "not_working", weekday: 0 });
  assert.deepEqual(q(make(), { day: SUN, staffId: "p2" }), { code: "not_working", staffId: "p2", weekday: 0 });
  assert.deepEqual(q(make(), { day: TUE }, "2026-11-17T19:30"), { code: "too_late", minutes: 60 });
  const full = make({ appointments: [appt("a1", `${WED}T10:00`, 600), appt("a2", `${WED}T10:00`, 600, { staffId: "p2" })] });
  assert.deepEqual(freeStarts(full, { staffId: null, serviceIds: ["s1"], day: WED, duration: 30 }, { now: NOW }), []);
  assert.deepEqual(q(full), { code: "full" });
});

test("which days can be picked", () => {
  const db = make({ timeOff: [{ id: "t", staffId: "p1", start: `${WED}T00:00`, end: `${WED}T23:59`, note: "" }] });
  const q = (day, staffId = null) => dayBlock(db, { staffId, serviceIds: ["s1"] }, day, { now: NOW });
  assert.deepEqual(q("2026-11-16"), { code: "day_passed", hard: true });
  assert.deepEqual(q("2026-12-25"), { code: "max_days", days: 30, hard: false });
  assert.deepEqual(q(WED, "p1"), { code: "not_working", staffId: "p1", hard: false });
  assert.equal(q(WED), null); // p2 works
  assert.deepEqual(q(SUN), { code: "not_working", hard: false });
  assert.equal(q(TUE), null);
});

test("anyone: the team's booking goes to the first clean specialist, else the first without a hard reason", () => {
  const db = make({ appointments: [appt("a1", `${WED}T12:00`, 60)] });
  assert.equal(assign(db, draft(`${WED}T12:00`, { staffId: null }), { by: "team", now: NOW }).staffId, "p2");
  assert.equal(assign(db, draft(`${WED}T11:00`, { staffId: null }), { by: "team", now: NOW }).staffId, "p1");
  // Sunday: nobody is clean, the first eligible one comes back with the soft reason.
  const sun = assign(db, draft(`${SUN}T12:00`, { staffId: null }), { by: "team", now: NOW });
  assert.equal(sun.staffId, "p1");
  assert.deepEqual(codes(sun.result.soft), ["day_off"]);
  assert.deepEqual(assign(db, draft(`${WED}T12:00`, { staffId: null, serviceIds: ["nope"] }), { by: "team", now: NOW }), { staffId: null, result: { hard: [{ code: "nobody_does" }], soft: [] } });
});

test("the step a new booking starts in", () => {
  assert.equal(startStage(STAGES, "team").id, "ok");
  assert.equal(startStage(STAGES, "customer").id, "new");
  // A list without a pending step: both start in the first step.
  assert.equal(startStage(STAGES.slice(1), "customer").id, "ok");
  // Two booked steps: the first one.
  assert.equal(startStage([{ id: "b0", kind: "booked" }, ...STAGES], "team").id, "b0");
  assert.equal(startStage([], "team"), null);
});

test("step rules by kind: here only on the day, done from the day on, no-show only after the start", () => {
  const today = appt("a", `${TUE}T15:00`);
  const tomorrow = appt("b", `${WED}T15:00`);
  const yesterday = appt("c", "2026-11-16T15:00");
  const at = (a, id, now = NOW) => stepBlock(STAGES, a, id, now);
  assert.equal(at(today, "in"), null);
  assert.deepEqual(at(tomorrow, "in"), { code: "here_early", day: WED });
  assert.deepEqual(at(yesterday, "in"), { code: "here_late", day: "2026-11-16" });
  assert.equal(at(today, "done"), null);
  assert.equal(at(yesterday, "done"), null);
  assert.deepEqual(at(tomorrow, "done"), { code: "done_early", day: WED });
  assert.deepEqual(at(today, "miss"), { code: "noshow_early", start: `${TUE}T15:00` });
  assert.equal(at(today, "miss", `${TUE}T15:00`), null);
  assert.equal(at(today, "miss", `${TUE}T15:01`), null);
  assert.equal(at(yesterday, "miss"), null);
  for (const a of [today, tomorrow, yesterday]) for (const id of ["new", "ok", "off"]) assert.equal(at(a, id), null);
  assert.deepEqual(at(today, "gone"), { code: "unknown_step", id: "gone" });
});

test("bookings inside time off, and what is still coming", () => {
  const db = make({ appointments: [appt("a1", `${WED}T12:00`, 60), appt("a2", `${WED}T12:00`, 60, { staffId: "p2" }), appt("a3", `${WED}T16:00`, 30, { status: "off" }), appt("a4", `${TUE}T08:00`, 30)] });
  assert.deepEqual(bookingsInside(db, { staffId: "p1", start: `${WED}T12:30`, end: `${WED}T16:59` }).map((a) => a.id), ["a1"]);
  assert.deepEqual(bookingsInside(db, { staffId: null, start: `${WED}T00:00`, end: `${WED}T23:59` }).map((a) => a.id), ["a1", "a2"]);
  assert.deepEqual(bookingsInside(db, { staffId: null, start: `${WED}T13:00`, end: `${WED}T13:59` }), []);
  assert.deepEqual(upcoming(db, NOW).map((a) => a.id), ["a1", "a2"]);
  assert.deepEqual(totals(db, ["s1", "s2"]), { duration: 90, price: 140000 });
});

test("repeat bookings: the days of a series", () => {
  const weekly = { startDay: TUE, every: 1, weekdays: [2], until: null, count: null };
  assert.deepEqual(seriesDays(weekly, TUE, "2026-12-08"), [TUE, "2026-11-24", "2026-12-01", "2026-12-08"]);
  assert.deepEqual(seriesDays(weekly, WED, "2026-12-07"), ["2026-11-24", "2026-12-01"]);
  assert.deepEqual(seriesDays({ ...weekly, until: "2026-11-24" }, TUE, "2027-01-01"), [TUE, "2026-11-24"]);
  assert.deepEqual(seriesDays({ ...weekly, count: 3 }, TUE, "2027-01-01"), [TUE, "2026-11-24", "2026-12-01"]);
  // Every second week on Tuesday and Friday: count runs over all of its days.
  const two = { startDay: TUE, every: 2, weekdays: [2, 5], until: null, count: 4 };
  assert.deepEqual(seriesDays(two, TUE, "2027-01-01"), [TUE, "2026-11-20", "2026-12-01", "2026-12-04"]);
  assert.deepEqual(seriesDays(two, "2026-11-21", "2027-01-01"), ["2026-12-01", "2026-12-04"]);
  // Weeks start on Monday: a series started on a Sunday repeats Monday of the week after next, not tomorrow.
  assert.deepEqual(seriesDays({ startDay: SUN, every: 2, weekdays: [0, 1], until: null, count: null }, SUN, "2026-12-07"), [SUN, "2026-11-30", "2026-12-06"]);
  assert.deepEqual(seriesDays({ ...weekly, weekdays: [] }, TUE, "2027-01-01"), []);
  assert.equal(seriesEnded({ ...weekly, count: 3 }, "2026-11-30"), false);
  assert.equal(seriesEnded({ ...weekly, count: 3 }, "2026-12-01"), true);
  assert.equal(seriesEnded({ ...weekly, until: "2026-12-01" }, "2026-12-01"), true);
  assert.equal(seriesEnded(weekly, "2030-01-01"), false);
});

test("time helpers", () => {
  assert.equal(addMinutes("2026-11-17T23:30", 45), "2026-11-18T00:15");
  assert.equal(addMinutes("2026-12-31T23:59", 1), "2027-01-01T00:00");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(weekday(TUE), 2);
  assert.equal(weekStart(SUN), "2026-11-16");
  assert.equal(daysBetween(TUE, "2026-12-01"), 14);
  assert.equal(absMin(`${WED}T00:00`) - absMin(`${TUE}T23:00`), 60);
  assert.equal(isMoment("2026-11-17T09:30"), true);
  for (const bad of ["2026-11-17", "2026-11-17T24:00", "2026-02-30T10:00", "2026-11-17T9:30", "2026-11-17T09:30:00", 5, null]) assert.equal(isMoment(bad), false, String(bad));
  assert.equal(nowIn("Asia/Tashkent", new Date("2026-11-17T20:30:00Z")), "2026-11-18T01:30");
  assert.equal(nowIn("UTC", new Date("2026-11-17T00:05:00Z")), "2026-11-17T00:05");
});
