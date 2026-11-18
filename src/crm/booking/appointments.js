// Bookings. Every write runs the shared check() on fresh rows inside the workspace's write
// transaction, so what the dialog showed and what the server decides can only differ when the
// calendar changed in between. The database has the last word on double bookings (the exclusion
// constraint in sql/crm/10-booking.sql); its refusal reads the same as check()'s.
//
// Who does it (`who`): the team ({ user, role }), or a customer acting for themselves
// ({ by: "customer", via: "page" | "ai", source, capped }: a public page, the AI agent). Server
// code alone makes a customer `who`, so its `source` is trusted. A customer's booking is judged
// as a customer (shared check() with by: "customer", nothing forced), starts in the first step,
// takes its length and price from the services, counts toward their daily share (`capped`), and
// can be moved or cancelled by them only while cancelProblem() allows. Their refusals carry
// only what a customer may see (refusalsFor). Booking fields: a customer fills only the required
// ones (customerFields, what the callers ask for); a booking is never refused for one left empty,
// and its history says which were missing, for the team to fill.
import { z } from "zod";
import { HttpError, forbidden, notFound } from "../../core/http.js";
import { write, wall, isUuid, updateRow } from "../db.js";
import { refusal, refusalsFor, shareUsed } from "../errors.js";
import { uuid, serviceList, moment, minutes, money, label } from "../shapes.js";
import { findCustomer, needSource } from "../core/customers.js";
import { cleanFields, customerFields, missingFields, same, stageIds, PER_PHONE_PER_DAY } from "../shared/index.js";
import { check, verdict, assign, totals, startStage, kindHolds, holdsTime, cancelProblem } from "../shared/booking.js";
import { dayOf, fromMin, toMin } from "../shared/time.js";
import { poolOf } from "../shared/branches.js";
import { needBranch, ownBranch } from "../branches/access.js";
import { APPT, loadRules } from "./rows.js";
import { linkOf } from "./staff.js";

/* ───── Shapes ───── */

const shape = {
  customerId: uuid,
  staffId: uuid.nullable(), // null: anyone who is free then
  serviceIds: serviceList,
  start: moment,
  duration: minutes, // left out: the services' own
  price: money, // left out: the services' own
  source: z.string().trim().max(40),
  note: label(2000),
  fields: z.record(z.unknown()),
  // Book over the business's own rules (soft reasons). Works only when rules.override is on.
  force: z.boolean(),
};
// branchId: where "anyone" is looked for (a named specialist books where they work).
export const createSchema = z.object({ ...shape, branchId: uuid }).partial().required({ customerId: true, serviceIds: true, start: true }).strict();
export const editSchema = z.object(shape).partial().strict().refine((v) => Object.keys(v).some((k) => k !== "force"), "Nothing to change.");
export const moveSchema = z.object({ start: shape.start, staffId: uuid, force: z.boolean() }).partial().strict().refine((v) => v.start || v.staffId, "Say where the booking goes.");
export const paySchema = z.object({ paid: z.boolean() }).strict();

/* ───── Shared pieces ───── */

/** A booking of this workspace that this person may see (their own, their branch's), or 404. */
export async function getAppointment(q, cfg, id, me) {
  const { rows } = isUuid(id) ? await q(`SELECT ${APPT("$3")} FROM crm_appointments WHERE workspace_id = $1 AND id = $2`, [cfg.workspaceId, id, cfg.timezone]) : { rows: [] };
  if (!rows[0] || (me?.only && rows[0].staffId !== me.only) || (me?.branch && rows[0].branchId !== me.branch)) throw notFound("Booking not found");
  return rows[0];
}

const byCustomer = (who) => who?.by === "customer";

/**
 * Who did something, as a booking keeps it: { by: name, byId }, and for a customer acting for
 * themselves also `customer: true` and where (`via`: "page", "ai"). A booking keeps it as its
 * `createdBy` too.
 */
export const whoOf = (who) => ({ by: who?.user?.name || "", byId: who?.user?.id || null, ...(byCustomer(who) ? { customer: true, via: who.via } : {}) });

/** One line of a booking's history: what was done, when (the business's clock) and by whom (whoOf). */
export const entry = (cfg, who, what) => ({ at: cfg.now, ...what, ...whoOf(who) });

/**
 * The booking rules said no: 422 { code: "rules", hard, soft, override }. `override` says whether
 * force could pass the soft ones.
 */
export const refuse = (cfg, { hard, soft }, message = hard.length ? "This time can't be booked." : "This time is outside the booking rules.") =>
  refusal(hard, soft, { message, override: cfg.data.settings.rules?.override !== false });

/**
 * Runs a write that could break the no-double-booking constraint. If it does, the transaction
 * goes on, and the caller gets the same refusal check() gives: { code: "taken", staffId, id, from, to }.
 */
async function guarded(c, cfg, draft, run) {
  await c.query("SAVEPOINT booking");
  try {
    const out = await run();
    await c.query("RELEASE SAVEPOINT booking");
    return out;
  } catch (e) {
    // A visit that would run into the next day: check() says so first; this is the backstop.
    if (e.code === "23514" && e.constraint === "crm_appointments_same_day") {
      await c.query("ROLLBACK TO SAVEPOINT booking");
      throw refuse(cfg, { hard: [{ code: "ends_next_day" }], soft: [] });
    }
    if (e.code !== "23P01" || e.constraint !== "crm_appointments_no_overlap") throw e;
    await c.query("ROLLBACK TO SAVEPOINT booking");
    const clash = (
      await c.query(
        `SELECT id, to_char(start_at, 'HH24:MI') AS "from", duration FROM crm_appointments
          WHERE workspace_id = $1 AND staff_id = $2 AND busy AND id IS DISTINCT FROM $5
            AND tsrange(start_at, start_at + make_interval(mins => duration)) && tsrange($3::timestamp, $3::timestamp + make_interval(mins => $4::int))
          ORDER BY start_at LIMIT 1`,
        [cfg.workspaceId, draft.staffId, draft.start, draft.duration, draft.ignoreId || null]
      )
    ).rows[0];
    const hard = [{ code: "taken", staffId: draft.staffId, ...(clash ? { id: clash.id, from: clash.from, to: fromMin(toMin(clash.from) + clash.duration) } : {}) }];
    throw refuse(cfg, { hard, soft: [] });
  }
}

/**
 * Services that exist; a new booking (or a service added to one) also needs them switched on. To
 * a customer a switched-off service is simply not one they can book: bad_service.
 */
function needServices(db, ids, kept = [], who = null) {
  for (const id of ids) {
    const s = db.services.find((x) => x.id === id);
    if (!s || (!s.active && byCustomer(who))) throw new HttpError(400, "One of the services no longer exists.", { code: "bad_service", serviceId: id });
    if (!s.active && !kept.includes(id)) throw new HttpError(400, "One of the services is switched off.", { code: "service_off", serviceId: id });
  }
}
async function needCustomer(q, cfg, id) {
  if (!(await findCustomer(q, cfg, { id }))) throw new HttpError(400, "This customer no longer exists.", { code: "bad_customer" });
}
/**
 * The booking's own fields, checked against the workspace's list: { values, missing: [required
 * field ids left empty] }. The team must fill the required ones. A customer fills only those
 * (customerFields: what they send for the team's own is left out) and keeps a note of the rest.
 */
function fieldsOf(cfg, sent, stored, who = null) {
  const defs = cfg.data.fields.appointment;
  const { values, errors } = cleanFields(byCustomer(who) ? customerFields(defs) : defs, sent || {}, stored);
  if (Object.keys(errors).length) throw new HttpError(400, "One of the booking's fields has a value that doesn't fit it.", { code: "bad_fields", fields: errors });
  const missing = missingFields(defs, values).map((f) => f.id);
  if (missing.length && !byCustomer(who)) throw new HttpError(400, "Fill in the required fields.", { code: "missing_fields", fields: missing });
  return { values, missing };
}

/** How many bookings this customer made themselves today (the business's day) that are not called off. */
export async function bookedByCustomerToday(q, cfg, customerId) {
  const { rows } = await q(
    `SELECT count(*)::int AS n FROM crm_appointments
      WHERE workspace_id = $1 AND customer_id = $2 AND customer_made AND status <> ALL($3::text[]) AND ${wall("created_at", "$4")} >= $5`,
    [cfg.workspaceId, customerId, stageIds(cfg.data.apptStages, "cancelled"), cfg.timezone, `${dayOf(cfg.now)}T00:00`]
  );
  return rows[0].n;
}
/**
 * Someone who works only with their own bookings books only for themselves; someone limited to a
 * branch, only with its specialists.
 */
function ownOnly(me, staffId, db) {
  if (me.only && staffId !== me.only) throw forbidden("You can book only for yourself.");
  const at = db.staff.find((p) => p.id === staffId)?.branchId;
  if (at) ownBranch({ branchOnly: me.branch }, at);
}

/**
 * Decides who takes a visit and whether it may be booked. Throws the 422 refusal, or returns
 * { staffId, soft } (soft: the rule reasons that were passed with force). `pool`: the branch
 * "anyone" is looked for in (null: every branch).
 */
function decide(cfg, db, draft, me, force, who = null, pool = null) {
  const by = byCustomer(who) ? "customer" : "team";
  const opts = { by, now: cfg.now };
  const asked = draft.staffId || me.only;
  if (asked) ownOnly(me, asked, db);
  const { staffId, result } = asked ? { staffId: asked, result: check(db, { ...draft, staffId: asked }, opts) } : assign(poolOf(db, pool), draft, opts);
  if (verdict(db, result, { by, force: by === "team" && force }) !== "ok") throw refuse(cfg, result);
  return { staffId, soft: result.soft };
}

/** A customer may move or cancel their own booking only while it is waiting or confirmed, until rules.cancelUntil before it. */
export function needChangeable(cfg, a, who) {
  const problem = byCustomer(who) && cancelProblem(cfg.data.apptStages, a, cfg.data.settings.rules, cfg.now);
  if (problem) throw refusal([problem], [], { message: "Only the team can change this booking now." });
}

/**
 * Stores a new booking. The caller has checked it; the constraint still guards the time. `who`:
 * who made it (as for entry()), kept on it; null when nobody is known.
 */
export function insertAppointment(c, cfg, a, who) {
  return guarded(c, cfg, a, async () => {
    const creator = who ? whoOf(who) : null;
    const { rows } = await c.query(
      `INSERT INTO crm_appointments (workspace_id, branch_id, customer_id, staff_id, service_ids, start_at, duration, price, status, busy, source, note, fields, series_id, series_day, created_by, customer_made, history, creator)
       VALUES ($1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING ${APPT("$2")}`,
      [cfg.workspaceId, cfg.timezone, cfg.branchId, a.customerId, a.staffId, a.serviceIds, a.start, a.duration, a.price, a.status, a.busy, a.source, JSON.stringify(a.note), JSON.stringify(a.fields), a.seriesId || null, a.seriesDay || null, creator?.byId || null, byCustomer(who), JSON.stringify(a.history || []), creator && JSON.stringify(creator)]
    );
    return rows[0];
  });
}

const MAP = { columns: { customerId: "customer_id", staffId: "staff_id", serviceIds: "service_ids", start: "start_at" }, json: ["note", "fields", "history"] };
/** Saves the changed columns of a booking and returns it as the app reads it. */
export function saveAppointment(c, cfg, a, patch) {
  const draft = { staffId: patch.staffId ?? a.staffId, start: patch.start ?? a.start, duration: patch.duration ?? a.duration, ignoreId: a.id };
  return guarded(c, cfg, draft, async () => (await updateRow(c, cfg, "crm_appointments", MAP, APPT, a.id, patch))[0]);
}

/* ───── Writes ───── */

/**
 * A new booking. One the team makes by hand starts in the first `booked` step: they have spoken
 * with the customer; one a customer makes starts in the first step (see the top). `at`: the
 * workspace's id, or a write already open (db.js write()). Answers { changes, id, forced? }
 * (forced: the rule reasons the team passed with force).
 */
export function bookAppointment(at, who, body) {
  return write(at, (c, cfg, q) => refusalsFor(who, async () => {
    const customer = byCustomer(who);
    const me = await linkOf(q, cfg.workspaceId, who);
    if (customer && who.capped && (await bookedByCustomerToday(q, cfg, body.customerId)) >= PER_PHONE_PER_DAY) throw shareUsed();
    const day = dayOf(body.start);
    const db = await loadRules(q, cfg, day, day);
    await needCustomer(q, cfg, body.customerId);
    needServices(db, body.serviceIds, [], who);
    if (!customer) needSource(cfg, body.source, undefined, "booking");
    const sum = totals(db, body.serviceIds);
    const duration = customer ? sum.duration : body.duration ?? sum.duration;
    const draft = { staffId: body.staffId || null, serviceIds: body.serviceIds, start: body.start, duration };
    // "Anyone" at the branch sent (or the person's own); a named specialist books where they work.
    const pool = body.branchId || me.branch ? await needBranch(q, cfg, who, body.branchId, { work: true }) : null;
    const { staffId, soft } = decide(cfg, db, draft, me, body.force, who, pool);
    const fields = fieldsOf(cfg, body.fields, {}, who);
    const stage = startStage(cfg.data.apptStages, customer ? "customer" : "team");
    if (!stage) throw new HttpError(409, "The bookings board has no steps. Add one in CRM settings.", { code: "no_steps" });
    const row = await insertAppointment(c, cfg, {
      customerId: body.customerId, staffId, serviceIds: body.serviceIds, start: body.start, duration, price: customer ? sum.price : body.price ?? sum.price,
      status: stage.id, busy: kindHolds(stage.kind), source: (customer ? who.source : body.source) || "", note: body.note ?? "", fields: fields.values,
      history: fields.missing.length ? [entry(cfg, who, { type: "missing", fields: fields.missing })] : [],
    }, who);
    return { changes: { set: { appointments: [row] } }, id: row.id, ...(soft.length ? { forced: soft } : {}) };
  }));
}

/**
 * Edits a booking: the customer, services, specialist, time, length, price, note, fields.
 * The rules are asked only when the specialist, the time, the length or the services change, and
 * only for a booking that keeps its time: fixing the note of yesterday's visit is always fine.
 * Dragging on the calendar (POST …/move) comes here too, with just the time and the specialist.
 * History gets a line for a move, a new note and new details, as the booking panel shows them.
 * A customer only moves their own booking (`start`, and `staffId`: another one, or null for
 * anyone free), judged as a customer.
 */
export function editAppointment(at, who, id, sent) {
  return write(at, (c, cfg, q) => refusalsFor(who, async () => {
    const me = await linkOf(q, cfg.workspaceId, who);
    const a = await getAppointment(q, cfg, id, me);
    needChangeable(cfg, a, who);
    // A customer moves their visit: another time, another specialist or anyone free.
    const body = byCustomer(who) ? { start: sent.start, ...(sent.staffId !== undefined ? { staffId: sent.staffId } : {}) } : sent;
    const patch = {};
    const start = body.start ?? a.start;
    const db = await loadRules(q, cfg, dayOf(start), dayOf(start));
    if (body.customerId && body.customerId !== a.customerId) {
      await needCustomer(q, cfg, body.customerId);
      patch.customerId = body.customerId;
    }
    const services = body.serviceIds && !same(body.serviceIds, a.serviceIds) ? body.serviceIds : null;
    if (services) {
      needServices(db, services, a.serviceIds);
      patch.serviceIds = services;
    }
    // New services bring their own length and price, unless the caller says otherwise.
    const sum = services ? totals(db, services) : null;
    const duration = body.duration ?? (sum ? sum.duration : a.duration);
    const price = body.price ?? (sum ? sum.price : a.price);
    if (duration !== a.duration) patch.duration = duration;
    if (price !== a.price) patch.price = price;
    if (start !== a.start) patch.start = start;
    const anyone = body.staffId === null;
    const timeChanged = anyone || (body.staffId && body.staffId !== a.staffId) || patch.start || patch.duration || patch.serviceIds;
    let staffId = a.staffId;
    let soft = [];
    if (timeChanged) {
      const draft = { staffId: anyone ? null : body.staffId || a.staffId, serviceIds: services || a.serviceIds, start, duration, ignoreId: a.id };
      // "Anyone" stays at the booking's branch.
      if (holdsTime(db, a)) ({ staffId, soft } = decide(cfg, db, draft, me, body.force, who, a.branchId));
      else {
        // A cancelled or missed booking holds no time, so the rules wait until it is brought back.
        // Only a visit no booking can be (none, or running into the next day) is refused now.
        staffId = draft.staffId || a.staffId;
        ownOnly(me, staffId, db);
        if (!db.staff.some((p) => p.id === staffId)) throw new HttpError(400, "This specialist no longer exists.", { code: "bad_staff" });
        const hard = check(db, { ...draft, staffId }, { by: "team", now: cfg.now }).hard.filter((r) => r.code === "bad_duration" || r.code === "ends_next_day");
        if (hard.length) throw refuse(cfg, { hard, soft: [] });
      }
      if (staffId !== a.staffId) patch.staffId = staffId;
    }
    if (body.source !== undefined && body.source !== a.source) {
      needSource(cfg, body.source, a.source, "booking");
      patch.source = body.source;
    }
    if (body.note !== undefined && !same(body.note, a.note)) patch.note = body.note;
    if (body.fields !== undefined) {
      const { values } = fieldsOf(cfg, body.fields, a.fields);
      if (!same(values, a.fields)) patch.fields = values;
    }
    if (!Object.keys(patch).length) return { changes: {} };
    const lines = [];
    if (patch.start || patch.staffId) lines.push({ type: "moved", from: a.start, to: start, fromStaff: a.staffId, toStaff: staffId });
    if (patch.note !== undefined) lines.push({ type: "note" });
    if (patch.fields) lines.push({ type: "fields" });
    if (lines.length) patch.history = [...a.history, ...lines.map((l) => entry(cfg, who, l))];
    const row = await saveAppointment(c, cfg, a, patch);
    return { changes: { set: { appointments: [row] } }, ...(soft.length ? { forced: soft } : {}) };
  }));
}

/** Marks a booking paid or unpaid. */
export function payAppointment(workspaceId, who, id, body) {
  return write(workspaceId, async (c, cfg, q) => {
    const a = await getAppointment(q, cfg, id, await linkOf(q, workspaceId, who));
    if (a.paid === body.paid) return { changes: {} };
    const row = await saveAppointment(c, cfg, a, { paid: body.paid, history: [...a.history, entry(cfg, who, { type: "paid", paid: body.paid })] });
    return { changes: { set: { appointments: [row] } } };
  });
}

/** Removes a booking for good (admins). Cancelling is the everyday way: it keeps the record. */
export function deleteAppointment(workspaceId, id) {
  return write(workspaceId, async (c, cfg, q) => {
    await getAppointment(q, cfg, id);
    await c.query("DELETE FROM crm_appointments WHERE workspace_id = $1 AND id = $2", [workspaceId, id]);
    return { changes: { del: { appointments: [id] } } };
  });
}
