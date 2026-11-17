// Time that can't be booked: a day off, a holiday, a blocked hour, for one specialist or for
// the whole business. Blocking time is part of working with the calendar, so the team may do it.
// Bookings already inside new blocked time are reported, never cancelled.
import { z } from "zod";
import { HttpError, forbidden } from "../../lib/http.js";
import { write, insertRow, updateRow } from "../db.js";
import { uuid, moment, label, someKey } from "../shapes.js";
import { bookingsInside } from "../shared/booking.js";
import { dayOf } from "../shared/time.js";
import { TIME_OFF, one, loadRules } from "./rows.js";
import { linkOf } from "./staff.js";

const shape = {
  staffId: uuid.nullable(), // null: the whole business
  start: moment,
  end: moment, // the last minute it covers: all day = 00:00 … 23:59
  note: label(200),
};
export const timeOffCreateSchema = z.object(shape).partial().required({ start: true, end: true }).strict();
export const timeOffUpdateSchema = z.object(shape).partial().strict().refine(someKey, "Nothing to change.");

const MAP = { columns: { staffId: "staff_id", start: "start_at", end: "end_at" }, json: ["note"] };

/** A team member who sees only their own bookings blocks only their own time. */
function ownOff(me, staffId) {
  if (me.only && staffId !== me.only) throw forbidden("You can block only your own time.");
}
async function cleanOff(c, cfg, v) {
  if (v.end < v.start) throw new HttpError(400, "The end must be after the start.", { code: "bad_span" });
  if (v.staffId && !(await c.query("SELECT 1 FROM crm_staff WHERE workspace_id = $1 AND id = $2", [cfg.workspaceId, v.staffId])).rows[0]) {
    throw new HttpError(400, "This specialist no longer exists.", { code: "bad_staff" });
  }
}
/** Open bookings that sit inside the blocked time: { count, ids }. */
async function inside(q, cfg, off) {
  const list = bookingsInside(await loadRules(q, cfg, dayOf(off.start), dayOf(off.end)), off);
  return { count: list.length, ids: list.map((a) => a.id) };
}

export function createTimeOff(workspaceId, who, input) {
  return write(workspaceId, async (c, cfg, q) => {
    const v = { staffId: null, ...input };
    ownOff(await linkOf(q, workspaceId, who), v.staffId);
    await cleanOff(c, cfg, v);
    const rows = await insertRow(c, cfg, "crm_time_off", MAP, TIME_OFF, v, { branch_id: cfg.branchId });
    return { changes: { set: { timeOff: rows } }, id: rows[0].id, inside: await inside(q, cfg, rows[0]) };
  });
}

export function updateTimeOff(workspaceId, who, id, input) {
  return write(workspaceId, async (c, cfg, q) => {
    const stored = await one(q, cfg, "crm_time_off", TIME_OFF, id, "Blocked time");
    const me = await linkOf(q, workspaceId, who);
    ownOff(me, stored.staffId);
    const next = { ...stored, ...input };
    ownOff(me, next.staffId);
    await cleanOff(c, cfg, next);
    const rows = await updateRow(c, cfg, "crm_time_off", MAP, TIME_OFF, id, input);
    return { changes: { set: { timeOff: rows } }, inside: await inside(q, cfg, rows[0]) };
  });
}

export function deleteTimeOff(workspaceId, who, id) {
  return write(workspaceId, async (c, cfg, q) => {
    const stored = await one(q, cfg, "crm_time_off", TIME_OFF, id, "Blocked time");
    ownOff(await linkOf(q, workspaceId, who), stored.staffId);
    await c.query("DELETE FROM crm_time_off WHERE workspace_id = $1 AND id = $2", [workspaceId, id]);
    return { changes: { del: { timeOff: [id] } } };
  });
}
