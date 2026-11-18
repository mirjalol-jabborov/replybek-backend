// The AI agent in the Booking module: what can be booked, the times a customer may be offered
// (booking-times.js), and the customer's own bookings, which they may book, move and cancel after
// pressing Confirm (booking-changes.js).
import { read } from "../crm/db.js";
import * as bookingModule from "../crm/booking/index.js";
import { isOpen, cancelProblem, cancelBy, customerCatalogue } from "../crm/shared/booking.js";
import { stageOf } from "../crm/shared/lists.js";
import { customerFields } from "../crm/shared/fields.js";
import { absMin } from "../crm/shared/time.js";
import { mineTest } from "./customer.js";
import { SEEN, teamAndServices, serviceNames, staffName, freeTimes } from "./booking-times.js";
import { book, move, cancel } from "./booking-changes.js";
import { moneyText, nameIn, listName } from "./wording.js";
import { id, day, moment } from "./inputs.js";

/* ───── Lookups ───── */

async function listServices(access, args, lang) {
  return read(access.workspace.id, async (q, cfg) => {
    const { staff, services: on } = customerCatalogue(await teamAndServices(q, cfg));
    const ids = new Set(on.map((s) => s.id));
    return {
      services: on.map((s) => ({ service: s.id, name: nameIn(lang, s.name), category: listName(lang, cfg.data.serviceCategories, s.category), minutes: s.duration, price: s.price, priceText: moneyText(lang, s.price) })),
      specialists: staff.map((p) => ({ specialist: p.id, name: p.name, role: nameIn(lang, p.role), services: p.serviceIds.filter((id) => ids.has(id)) })),
      // What the business needs to know for every booking: ask the customer, then give it to crm_book.
      fields: customerFields(cfg.data.fields.appointment).map((f) => ({ field: f.id, name: nameIn(lang, f.name), type: f.type, ...(f.options ? { options: f.options } : {}) })),
    };
  });
}

async function myBookings(access, args, lang, link) {
  // A new customer, not added yet, has none.
  if (!link.customer_id) return { bookings: [] };
  return read(access.workspace.id, async (q, cfg) => {
    const mine = await mineTest(q, access, link, "appointment");
    const { appointments } = await bookingModule.customerHistory({ ...SEEN, q, cfg }, link.customer_id);
    const { staff, services } = await teamAndServices(q, cfg);
    const db = { apptStages: cfg.data.apptStages, staff, services };
    const rules = cfg.data.settings.rules;
    const ahead = appointments.filter((a) => mine(a) && isOpen(db, a) && absMin(a.start) + a.duration > absMin(cfg.now)).reverse();
    return {
      bookings: ahead.map((a) => ({
        booking: a.id,
        start: a.start,
        services: serviceNames(lang, db, a.serviceIds),
        specialist: staffName(db, a.staffId),
        step: nameIn(lang, stageOf(cfg.data.apptStages, a.status).name),
        canChange: !cancelProblem(cfg.data.apptStages, a, rules, cfg.now),
        changeUntil: cancelBy(a, rules),
      })),
    };
  });
}

/* ───── The tools ───── */

const services = { type: "array", items: id, minItems: 1, maxItems: 10, uniqueItems: true, description: "Service ids from crm_list_services." };

export const tools = [
  {
    name: "crm_list_services",
    module: "booking",
    kind: "read",
    description: "The services the business offers (name, minutes, price), its specialists with the services each one does, and the fields the business needs filled for every booking (ask the customer for them). Ids here are what the other booking tools take.",
    when: "The customer asks what can be booked, prices, how long something takes, or who does it; and before looking for free times.",
    input: { type: "object", properties: {}, additionalProperties: false },
    run: listServices,
  },
  {
    name: "crm_free_times",
    module: "booking",
    kind: "read",
    description:
      "The start times a customer may book on one day for these services, with a specialist or anyone free. Only these times can be booked. Answers { day, minutes, times: [{ start, specialist, specialistName }], more, none } where none is a reason code when the day has no times (day_passed, max_days, closed, not_working, too_late, full, nobody_does).",
    when: "The customer wants to book, or to move a booking, and you need times to offer. Ask about another day when there are none.",
    input: { type: "object", properties: { services, specialist: { ...id, description: "Leave out for anyone free." }, day }, required: ["services", "day"], additionalProperties: false },
    run: freeTimes,
  },
  {
    name: "crm_my_bookings",
    module: "booking",
    kind: "read",
    customer: true,
    description: "The customer's own upcoming bookings: when, what, with whom, its step, and whether they may still change it themselves (canChange, changeUntil).",
    when: "The customer asks about their booking, or wants to cancel or move one.",
    input: { type: "object", properties: {}, additionalProperties: false },
    run: myBookings,
  },
  {
    name: "crm_book",
    module: "booking",
    kind: "write",
    customer: true,
    description:
      "Books a visit for the customer at a start time from crm_free_times, with their answers for the business's booking fields. Shows the customer a card to confirm; nothing is booked before they press Confirm, and a newer card replaces the one before. A refusal comes as { error: \"rules\", hard, soft, times }: say why in plain words and offer the times listed. On Confirm, price_changed means the price or length changed since the card: tell the customer and book again if they agree. phone_limit means this phone made the day's bookings already: offer to pass the request to the team.",
    when: "The customer chose the service, the time and (if they care) the specialist.",
    input: {
      type: "object",
      properties: {
        services,
        start: moment,
        specialist: { ...id, description: "Leave out for anyone free." },
        note: { type: "string", maxLength: 500 },
        fields: { type: "object", maxProperties: 20, additionalProperties: { type: ["string", "number", "boolean"] }, description: "The customer's answers for the fields from crm_list_services, by field." },
      },
      required: ["services", "start"],
      additionalProperties: false,
    },
    op: book,
  },
  {
    name: "crm_move_booking",
    module: "booking",
    kind: "write",
    customer: true,
    description:
      "Moves one of the customer's own bookings to another start time from crm_free_times. Shows a card to confirm. cancel_closed (with minutes) means it is too close to the visit for the customer to change it: offer to pass the request to the team.",
    when: "The customer wants another time for a booking they have.",
    input: { type: "object", properties: { booking: { ...id, description: "From crm_my_bookings." }, start: moment, specialist: { type: "string", description: "A specialist's id, or \"any\". Leave out to keep the same one." } }, required: ["booking", "start"], additionalProperties: false },
    op: move,
  },
  {
    name: "crm_cancel_booking",
    module: "booking",
    kind: "write",
    customer: true,
    description: "Cancels one of the customer's own bookings. Shows a card to confirm. cancel_closed (with minutes) means it is too close to the visit for the customer to cancel it: offer to pass the request to the team.",
    when: "The customer wants to cancel a booking they have.",
    input: { type: "object", properties: { booking: { ...id, description: "From crm_my_bookings." } }, required: ["booking"], additionalProperties: false },
    op: cancel,
  },
];
