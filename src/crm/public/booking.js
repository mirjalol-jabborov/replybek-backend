// The booking page: what can be booked, the free times a customer is offered, and booking,
// looking at and cancelling a visit. Every decision is the Booking module's own, made for a
// customer acting for themselves (pageCustomer): no reason of any kind passes, there is no force,
// only start times on the business's grid are offered, a booking starts in the first step of the
// board, and the customer cancels only while the business's cancelUntil allows.
import { read } from "../db.js";
import { bad } from "../errors.js";
import { mergeChanges } from "../changes.js";
import { bookAppointment, cancelAppointment, getAppointment, loadRules } from "../booking/index.js";
import { findOrAddCustomer } from "../core/customers.js";
import { eligible, customerCatalogue, totals, freeStarts, whyNone, rulesOf, cancelProblem, cancelBy } from "../shared/booking.js";
import { forCustomer } from "../shared/customer.js";
import { customerFields } from "../shared/fields.js";
import { stageOf } from "../shared/lists.js";
import { addDays, dayOf, fromMin } from "../shared/time.js";
import { openPart, pageWrite } from "./pages.js";
import { pageCustomer } from "./settings.js";
import { recordRequest, findRequest } from "./requests.js";

const today = (cfg) => dayOf(cfg.now);
const rulesIn = (cfg) => rulesOf({ settings: cfg.data.settings });

const specialist = (p) => ({ id: p.id, name: p.name, role: p.role, tone: p.tone });

/** Only what the page offers can be asked about: 400 bad_service, bad_staff. */
function needChoice(db, serviceIds, staffId) {
  const { services, staff } = customerCatalogue(db);
  const missing = serviceIds.find((id) => !services.some((s) => s.id === id));
  if (missing) throw bad("This service can't be booked here.", "bad_service", { serviceId: missing });
  if (staffId && !staff.some((p) => p.id === staffId)) throw bad("This specialist can't be booked here.", "bad_staff");
}

/**
 * GET services: { categories, services, staff, fields }. `fields`: the booking fields the
 * business needs filled ({ id, name, type, options? }): the page asks the customer for them.
 */
export function listServices(ws) {
  return read(ws.id, async (q, cfg) => {
    openPart(cfg, "booking");
    const db = await loadRules(q, cfg, today(cfg), today(cfg));
    const { services, staff } = customerCatalogue(db);
    return {
      categories: cfg.data.serviceCategories.filter((c) => services.some((s) => s.category === c.id)).map((c) => ({ id: c.id, name: c.name })),
      services: services.map((s) => ({ id: s.id, name: s.name, category: s.category, duration: s.duration, price: s.price, staffIds: eligible(db, [s.id]).map((p) => p.id) })),
      staff: staff.map(specialist),
      fields: customerFields(cfg.data.fields.appointment).map(({ id, name, type, options }) => ({ id, name, type, ...(options ? { options } : {}) })),
    };
  });
}

/** GET slots: the start times a customer is offered on a day: { day, duration, slots: [{ time, staffId }], none }. */
export function listSlots(ws, ask) {
  return read(ws.id, async (q, cfg) => {
    openPart(cfg, "booking");
    const db = await loadRules(q, cfg, ask.day, ask.day);
    needChoice(db, ask.serviceIds, ask.staffId);
    const query = { staffId: ask.staffId || null, serviceIds: ask.serviceIds, day: ask.day, duration: totals(db, ask.serviceIds).duration };
    const slots = freeStarts(db, query, { now: cfg.now }).map((s) => ({ time: fromMin(s.min), staffId: s.staffId }));
    return { day: ask.day, duration: query.duration, slots, none: slots.length ? null : forCustomer(whyNone(db, query, { now: cfg.now })) };
  });
}

/** The first and last day of a month written "2026-11". */
function monthSpan(month) {
  const first = `${month}-01`;
  const next = addDays(first, 31).slice(0, 7);
  return [first, addDays(`${next}-01`, -1)];
}

/**
 * GET days: the days of a month that have any free time for these services: { month, days }.
 * Only days from today up to rules.maxDays ahead can have any. The rows are read once for the
 * whole span; each day is then asked about with only its own bookings.
 */
export function listDays(ws, ask) {
  return read(ws.id, async (q, cfg) => {
    openPart(cfg, "booking");
    const [start, end] = monthSpan(ask.month);
    const from = start > today(cfg) ? start : today(cfg);
    const horizon = addDays(today(cfg), rulesIn(cfg).maxDays);
    const to = end < horizon ? end : horizon;
    if (from > to) return { month: ask.month, days: [] };
    const db = await loadRules(q, cfg, from, to);
    needChoice(db, ask.serviceIds, ask.staffId);
    const byDay = {};
    for (const a of db.appointments) (byDay[dayOf(a.start)] ||= []).push(a);
    const query = { staffId: ask.staffId || null, serviceIds: ask.serviceIds, duration: totals(db, ask.serviceIds).duration };
    const days = [];
    for (let day = from; day <= to; day = addDays(day, 1)) {
      if (freeStarts({ ...db, appointments: byDay[day] || [] }, { ...query, day }, { now: cfg.now }).length) days.push(day);
    }
    return { month: ask.month, days };
  });
}

/** A booking as its customer sees it. `db`: the rules' data (its specialist and services are in it). */
function bookingView(cfg, db, a, ref) {
  const stage = stageOf(cfg.data.apptStages, a.status);
  const person = db.staff.find((p) => p.id === a.staffId);
  const rules = rulesIn(cfg);
  return {
    ref,
    start: a.start,
    duration: a.duration,
    price: a.price,
    services: a.serviceIds.map((id) => db.services.find((s) => s.id === id)).filter(Boolean).map((s) => ({ id: s.id, name: s.name })),
    specialist: person ? specialist(person) : null,
    step: { name: stage.name, kind: stage.kind },
    canCancel: !cancelProblem(cfg.data.apptStages, a, rules, cfg.now),
    cancelBy: cancelBy(a, rules),
  };
}

/**
 * POST bookings: books a visit for a customer, found by phone or added. Who takes it, when it is
 * "anyone", is the first specialist with no reason against the time. Answers { ref, token }.
 * body: { serviceIds, staffId?, start, name, phone (already normalised), note, fields? }.
 */
export async function bookVisit(ws, body) {
  return pageWrite(ws, async (c, cfg, q) => {
    openPart(cfg, "booking");
    const db = await loadRules(q, cfg, dayOf(body.start), dayOf(body.start));
    needChoice(db, body.serviceIds, body.staffId);
    const who = pageCustomer(cfg);
    const customer = await findOrAddCustomer(c, cfg, body, who.source);
    const made = await bookAppointment({ c, cfg }, who, { customerId: customer.id, serviceIds: body.serviceIds, staffId: body.staffId || null, start: body.start, note: body.note, fields: body.fields });
    const request = await recordRequest(q, cfg, "booking", { appointmentId: made.id });
    return { changes: mergeChanges(made.changes, customer.added && { set: { customers: [customer.added] } }), ...request };
  });
}

/** GET bookings/:ref: { booking }. */
export function showBooking(ws, ref, token) {
  return read(ws.id, async (q, cfg) => {
    openPart(cfg, "booking");
    const r = await findRequest(q, cfg, "booking", ref, token);
    const a = await getAppointment(q, cfg, r.appointmentId);
    return { booking: bookingView(cfg, await loadRules(q, cfg, dayOf(a.start), dayOf(a.start)), a, r.ref) };
  });
}

/**
 * POST bookings/:ref/cancel: the customer calls their visit off, into the board's cancelled step,
 * while it is waiting or confirmed and at least rules.cancelUntil ahead. Answers { booking }.
 */
export async function cancelVisit(ws, ref, token) {
  return pageWrite(ws, async (c, cfg, q) => {
    openPart(cfg, "booking");
    const r = await findRequest(q, cfg, "booking", ref, token, "FOR UPDATE");
    const { changes } = await cancelAppointment({ c, cfg }, pageCustomer(cfg), r.appointmentId);
    const [row] = changes.set.appointments;
    return { changes, booking: bookingView(cfg, await loadRules(q, cfg, dayOf(row.start), dayOf(row.start)), row, r.ref) };
  });
}
