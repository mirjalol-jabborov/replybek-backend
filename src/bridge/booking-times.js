// The times a customer may be offered for a visit, and how a visit is judged for a customer: only
// times with no reason against them, on the start-time grid, nothing forced (by: "customer").
// The rules and loaders are the Booking module's own; this file only asks them as a customer.
import { read } from "../crm/db.js";
import * as bookingModule from "../crm/booking/index.js";
import { check, assign, verdict, totals, freeStarts, whyNone, customerCatalogue } from "../crm/shared/booking.js";
import { forCustomer } from "../crm/shared/customer.js";
import { dayOf, fromMin } from "../crm/shared/time.js";
import { nameIn } from "./wording.js";

const OFFERED = 12; // free times named in one answer; the agent asks for another day or time for more
// How the module's readers see the AI agent: nobody on the team, so no specialist's narrowing applies.
export const SEEN = { q: null, cfg: null, user: { id: null, name: "" }, role: "customer" };

/** The team and the services, through the module's own snapshot. */
export const teamAndServices = (q, cfg) => bookingModule.snapshot({ ...SEEN, q, cfg, want: (k) => k === "staff" || k === "services" });

/** Services a customer can book (shared customerCatalogue, as on the booking page), or { error: "bad_service" }. */
export function servicesProblem(db, ids) {
  const { services } = customerCatalogue(db);
  const off = ids.find((id) => !services.some((s) => s.id === id));
  return off ? { error: "bad_service", service: off } : null;
}

/** Who takes the visit and what the rules say, as for a customer. staffId null: anyone free then. */
export function judge(db, draft, now) {
  const opts = { by: "customer", now };
  const { staffId, result } = draft.staffId ? { staffId: draft.staffId, result: check(db, draft, opts) } : assign(db, draft, opts);
  return { staffId, result, ok: verdict(db, result, { by: "customer" }) === "ok" };
}

/** The free times of a day for these services, as a customer is offered them. */
export function offer(db, draft, now) {
  const query = { staffId: draft.staffId || null, serviceIds: draft.serviceIds, day: dayOf(draft.start), duration: draft.duration, ignoreId: draft.ignoreId };
  const name = (id) => db.staff.find((p) => p.id === id)?.name || "";
  const times = freeStarts(db, query, { now }).map((s) => ({ start: `${query.day}T${fromMin(s.min)}`, specialist: s.staffId, specialistName: name(s.staffId) }));
  return { times: times.slice(0, OFFERED), more: times.length > OFFERED, none: times.length ? null : forCustomer(whyNone(db, query, { now })) };
}

/** A refusal the agent can explain, with the times it can offer instead. */
export const refused = (db, draft, result, now) => ({ error: "rules", hard: result.hard.map(forCustomer), soft: result.soft.map(forCustomer), ...offer(db, draft, now) });

export const serviceNames = (lang, db, ids) => ids.map((id) => nameIn(lang, db.services.find((s) => s.id === id)?.name)).filter(Boolean).join(", ");
export const staffName = (db, id) => db.staff.find((p) => p.id === id)?.name || "";

/** The crm_free_times tool: the start times of one day. */
export async function freeTimes(access, args) {
  return read(access.workspace.id, async (q, cfg) => {
    const db = await bookingModule.loadRules(q, cfg, args.day, args.day);
    const problem = servicesProblem(db, args.services);
    if (problem) return problem;
    const draft = { staffId: args.specialist || null, serviceIds: args.services, start: `${args.day}T00:00`, duration: totals(db, args.services).duration };
    return { day: args.day, minutes: draft.duration, ...offer(db, draft, cfg.now) };
  });
}
