// Bookings. Every write runs the shared check() on fresh rows inside the workspace's write
// transaction, so what the dialog showed and what the server decides can only differ when the
// calendar changed in between. The database has the last word on double bookings (the exclusion
// constraint in sql/crm/10-booking.sql); its refusal reads the same as check()'s.
import { z } from "zod";
import { HttpError, forbidden, notFound } from "../../lib/http.js";
import { write } from "../db.js";
import { cleanFields, missingFields, hasId, stageOf, kindOf } from "../shared/index.js";
import { check, verdict, assign, totals, startStage, stepBlock, kindHolds, holdsTime, CLOSED_KINDS } from "../shared/booking.js";
import { dayOf, fromMin, toMin } from "../shared/time.js";
import { uuid, serviceList, moment, money, minutes, label } from "./shapes.js";
import { APPT, UUID, asQ, linkOf, loadRules, refusal } from "./rows.js";

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
export const createSchema = z.object(shape).partial().required({ customerId: true, serviceIds: true, start: true }).strict();
export const editSchema = z.object(shape).partial().strict().refine((v) => Object.keys(v).some((k) => k !== "force"), "Nothing to change.");
export const moveSchema = z.object({ start: shape.start, staffId: uuid, force: z.boolean() }).partial().strict().refine((v) => v.start || v.staffId, "Say where the booking goes.");
// force: bringing a cancelled or missed booking back over the business's rules, as when booking.
export const stepSchema = z.object({ status: z.string().min(1).max(40), reason: z.string().trim().max(500).optional(), force: z.boolean().optional() }).strict();
export const paySchema = z.object({ paid: z.boolean() }).strict();

/* ───── Shared pieces ───── */

/** A booking of this workspace that this person may see, or 404. */
export async function getAppointment(q, cfg, id, me) {
  const { rows } = UUID.test(id) ? await q(`SELECT ${APPT("$3")} FROM crm_appointments WHERE workspace_id = $1 AND id = $2`, [cfg.workspaceId, id, cfg.timezone]) : { rows: [] };
  if (!rows[0] || (me?.only && rows[0].staffId !== me.only)) throw notFound("Booking not found");
  return rows[0];
}

/** One line of a booking's history: what was done, when (the business's clock) and by whom. */
export const entry = (cfg, who, what) => ({ at: cfg.now, by: who?.user?.name || "", byId: who?.user?.id || null, ...what });

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
      throw refusal(cfg, { hard: [{ code: "ends_next_day" }], soft: [] });
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
    throw refusal(cfg, { hard, soft: [] });
  }
}

/** Services that exist; a new booking (or a service added to one) also needs them switched on. */
function needServices(db, ids, kept = []) {
  for (const id of ids) {
    const s = db.services.find((x) => x.id === id);
    if (!s) throw new HttpError(400, "One of the services no longer exists.", { code: "bad_service", serviceId: id });
    if (!s.active && !kept.includes(id)) throw new HttpError(400, "One of the services is switched off.", { code: "service_off", serviceId: id });
  }
}
async function needCustomer(c, cfg, id) {
  if (!(await c.query("SELECT 1 FROM crm_customers WHERE workspace_id = $1 AND id = $2", [cfg.workspaceId, id])).rows[0]) throw new HttpError(400, "This customer no longer exists.", { code: "bad_customer" });
}
/** Where it came from: one of the workspace's sources. What a booking already has stays valid ("ai", a removed source). */
function needSource(cfg, source, kept) {
  if (source && source !== kept && !hasId(cfg.data.sources, source)) throw new HttpError(400, "Choose where the booking came from.", { code: "bad_source" });
}
/** The booking's own fields, checked against the workspace's list. */
function fieldsOf(cfg, sent, stored) {
  const defs = cfg.data.fields.appointment;
  const { values, errors } = cleanFields(defs, sent || {}, stored);
  if (Object.keys(errors).length) throw new HttpError(400, "One of the booking's fields has a value that doesn't fit it.", { code: "bad_fields", fields: errors });
  const missing = missingFields(defs, values);
  if (missing.length) throw new HttpError(400, "Fill in the required fields.", { code: "missing_fields", fields: missing.map((f) => f.id) });
  return values;
}
/** Someone who works only with their own bookings books only for themselves. */
function ownOnly(me, staffId) {
  if (me.only && staffId !== me.only) throw forbidden("You can book only for yourself.");
}

/**
 * Decides who takes a visit and whether it may be booked. Throws the 422 refusal, or returns
 * { staffId, soft } (soft: the rule reasons that were passed with force).
 */
function decide(cfg, db, draft, me, force) {
  const opts = { by: "team", now: cfg.now };
  const asked = draft.staffId || me.only;
  if (asked) ownOnly(me, asked);
  const { staffId, result } = asked ? { staffId: asked, result: check(db, { ...draft, staffId: asked }, opts) } : assign(db, draft, opts);
  if (verdict(db, result, { by: "team", force }) !== "ok") throw refusal(cfg, result);
  return { staffId, soft: result.soft };
}

/** Stores a new booking. The caller has checked it; the constraint still guards the time. */
export function insertAppointment(c, cfg, a) {
  return guarded(c, cfg, a, async () => {
    const { rows } = await c.query(
      `INSERT INTO crm_appointments (workspace_id, branch_id, customer_id, staff_id, service_ids, start_at, duration, price, status, busy, source, note, fields, series_id, series_day, created_by)
       VALUES ($1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING ${APPT("$2")}`,
      [cfg.workspaceId, cfg.timezone, cfg.branchId, a.customerId, a.staffId, a.serviceIds, a.start, a.duration, a.price, a.status, a.busy, a.source, JSON.stringify(a.note), JSON.stringify(a.fields), a.seriesId || null, a.seriesDay || null, a.createdBy || null]
    );
    return rows[0];
  });
}

const COLUMN = { customerId: "customer_id", staffId: "staff_id", serviceIds: "service_ids", start: "start_at" };
const JSON_COLS = new Set(["note", "fields", "history"]);
/** Saves the changed columns of a booking and returns it as the app reads it. */
export function saveAppointment(c, cfg, a, patch) {
  const keys = Object.keys(patch);
  return guarded(c, cfg, { staffId: patch.staffId ?? a.staffId, start: patch.start ?? a.start, duration: patch.duration ?? a.duration, ignoreId: a.id }, async () => {
    const { rows } = await c.query(
      `UPDATE crm_appointments SET ${keys.map((k, i) => `${COLUMN[k] || k} = $${i + 4}`).join(", ")} WHERE workspace_id = $1 AND id = $2 RETURNING ${APPT("$3")}`,
      [cfg.workspaceId, a.id, cfg.timezone, ...keys.map((k) => (JSON_COLS.has(k) ? JSON.stringify(patch[k]) : patch[k]))]
    );
    return rows[0];
  });
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ───── Writes ───── */

/**
 * A booking the team makes by hand. It starts in the first `booked` step: they have spoken with
 * the customer. `who` = { user, role }. Answers { changes, id, forced? } (forced: the rule reasons
 * passed with force).
 */
export function bookAppointment(workspaceId, who, body) {
  return write(workspaceId, async (c, cfg) => {
    const q = asQ(c);
    const me = await linkOf(q, workspaceId, who);
    const day = dayOf(body.start);
    const db = await loadRules(q, cfg, day, day);
    await needCustomer(c, cfg, body.customerId);
    needServices(db, body.serviceIds);
    needSource(cfg, body.source);
    const sum = totals(db, body.serviceIds);
    const draft = { staffId: body.staffId || null, serviceIds: body.serviceIds, start: body.start, duration: body.duration ?? sum.duration };
    const { staffId, soft } = decide(cfg, db, draft, me, body.force);
    const fields = fieldsOf(cfg, body.fields, {});
    const stage = startStage(cfg.data.apptStages, "team");
    if (!stage) throw new HttpError(409, "The bookings board has no steps. Add one in CRM settings.", { code: "no_steps" });
    const row = await insertAppointment(c, cfg, {
      customerId: body.customerId, staffId, serviceIds: body.serviceIds, start: body.start, duration: draft.duration, price: body.price ?? sum.price,
      status: stage.id, busy: kindHolds(stage.kind), source: body.source || "", note: body.note ?? "", fields, createdBy: who.user.id,
    });
    return { changes: { set: { appointments: [row] } }, id: row.id, ...(soft.length ? { forced: soft } : {}) };
  });
}

/**
 * Edits a booking: the customer, services, specialist, time, length, price, note, fields.
 * The rules are asked only when the specialist, the time, the length or the services change, and
 * only for a booking that keeps its time: fixing the note of yesterday's visit is always fine.
 * Dragging on the calendar (POST …/move) comes here too, with just the time and the specialist.
 * History gets a line for a move, a new note and new details, as the booking panel shows them.
 */
export function editAppointment(workspaceId, who, id, body) {
  return write(workspaceId, async (c, cfg) => {
    const q = asQ(c);
    const me = await linkOf(q, workspaceId, who);
    const a = await getAppointment(q, cfg, id, me);
    const patch = {};
    const start = body.start ?? a.start;
    const db = await loadRules(q, cfg, dayOf(start), dayOf(start));
    if (body.customerId && body.customerId !== a.customerId) {
      await needCustomer(c, cfg, body.customerId);
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
      if (holdsTime(db, a)) ({ staffId, soft } = decide(cfg, db, draft, me, body.force));
      else {
        // A cancelled or missed booking holds no time, so the rules wait until it is brought back.
        // Only a visit no booking can be (none, or running into the next day) is refused now.
        staffId = draft.staffId || a.staffId;
        ownOnly(me, staffId);
        if (!db.staff.some((p) => p.id === staffId)) throw new HttpError(400, "This specialist no longer exists.", { code: "bad_staff" });
        const hard = check(db, { ...draft, staffId }, { by: "team", now: cfg.now }).hard.filter((r) => r.code === "bad_duration" || r.code === "ends_next_day");
        if (hard.length) throw refusal(cfg, { hard, soft: [] });
      }
      if (staffId !== a.staffId) patch.staffId = staffId;
    }
    if (body.source !== undefined && body.source !== a.source) {
      needSource(cfg, body.source, a.source);
      patch.source = body.source;
    }
    if (body.note !== undefined && !sameJson(body.note, a.note)) patch.note = body.note;
    if (body.fields !== undefined) {
      const fields = fieldsOf(cfg, body.fields, a.fields);
      if (!sameJson(fields, a.fields)) patch.fields = fields;
    }
    if (!Object.keys(patch).length) return { changes: {} };
    const lines = [];
    if (patch.start || patch.staffId) lines.push({ type: "moved", from: a.start, to: start, fromStaff: a.staffId, toStaff: staffId });
    if (patch.note !== undefined) lines.push({ type: "note" });
    if (patch.fields) lines.push({ type: "fields" });
    if (lines.length) patch.history = [...a.history, ...lines.map((l) => entry(cfg, who, l))];
    const row = await saveAppointment(c, cfg, a, patch);
    return { changes: { set: { appointments: [row] } }, ...(soft.length ? { forced: soft } : {}) };
  });
}

/**
 * The start a cancelled or missed booking had when it closed. Read from its history: going back
 * through the lines since the step that closed it, the earliest move says where it was.
 */
function startWhenClosed(stages, a) {
  let start = a.start;
  for (const line of [...(a.history || [])].reverse()) {
    if (line.type === "moved") start = line.from;
    if (line.type === "status" && !CLOSED_KINDS.includes(kindOf(stages, line.from))) break;
  }
  return start;
}
// What only says the visit's time has come or gone. A booking brought back at the time it had was
// booked once already, so these don't count for it: a missed visit may be put back (marked missed by mistake, it did happen).
const TIME_GONE = ["day_passed", "time_passed", "min_notice"];

/**
 * Puts a booking into another step, by what the step means: "here" only on the day of the visit,
 * "done" from that day on, "noshow" only after the start. A finished visit is marked paid.
 * Bringing a cancelled or missed booking back takes its time again, so it is judged like a new
 * booking at that time (force passes the soft reasons, when override is on). Answers { changes, forced? }.
 */
export function stepAppointment(workspaceId, who, id, body) {
  return write(workspaceId, async (c, cfg) => {
    const q = asQ(c);
    const a = await getAppointment(q, cfg, id, await linkOf(q, workspaceId, who));
    const stages = cfg.data.apptStages;
    if (!hasId(stages, body.status)) throw new HttpError(400, "This step no longer exists.", { code: "bad_step" });
    if (a.status === body.status) return { changes: {} };
    const to = stageOf(stages, body.status);
    const from = stageOf(stages, a.status);
    const block = stepBlock(stages, a, to.id, cfg.now);
    if (block) throw refusal(cfg, { hard: [block], soft: [] }, "This booking can't go into that step now.");
    let soft = [];
    if (CLOSED_KINDS.includes(from.kind) && kindHolds(to.kind)) {
      const db = await loadRules(q, cfg, dayOf(a.start), dayOf(a.start));
      const result = check(db, { ...a, ignoreId: a.id }, { by: "team", now: cfg.now });
      // Moved while it was closed, it is a new time like any other.
      if (startWhenClosed(stages, a) === a.start) {
        result.hard = result.hard.filter((r) => !TIME_GONE.includes(r.code));
        result.soft = result.soft.filter((r) => !TIME_GONE.includes(r.code));
      }
      if (verdict(db, result, { by: "team", force: body.force }) !== "ok") throw refusal(cfg, result);
      soft = result.soft;
    }
    const patch = { status: to.id, busy: kindHolds(to.kind), history: [...a.history, entry(cfg, who, { type: "status", from: a.status, to: to.id, reason: body.reason || "" })] };
    if (to.kind === "done" && !a.paid) patch.paid = true;
    const row = await saveAppointment(c, cfg, a, patch);
    return { changes: { set: { appointments: [row] } }, ...(soft.length ? { forced: soft } : {}) };
  });
}

/** Marks a booking paid or unpaid. */
export function payAppointment(workspaceId, who, id, body) {
  return write(workspaceId, async (c, cfg) => {
    const q = asQ(c);
    const a = await getAppointment(q, cfg, id, await linkOf(q, workspaceId, who));
    if (a.paid === body.paid) return { changes: {} };
    const row = await saveAppointment(c, cfg, a, { paid: body.paid, history: [...a.history, entry(cfg, who, { type: "paid", paid: body.paid })] });
    return { changes: { set: { appointments: [row] } } };
  });
}

/** Removes a booking for good (admins). Cancelling is the everyday way: it keeps the record. */
export function deleteAppointment(workspaceId, id) {
  return write(workspaceId, async (c, cfg) => {
    await getAppointment(asQ(c), cfg, id);
    await c.query("DELETE FROM crm_appointments WHERE workspace_id = $1 AND id = $2", [workspaceId, id]);
    return { changes: { del: { appointments: [id] } } };
  });
}
