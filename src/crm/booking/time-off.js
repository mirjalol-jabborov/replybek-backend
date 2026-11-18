// Time that can't be booked: a day off, a holiday, a blocked hour, for one specialist or for
// the whole business. Blocking time is part of working with the calendar, so the team may do it.
// Bookings already inside new blocked time are reported, never cancelled.
import { z } from "zod";
import { HttpError, forbidden, notFound } from "../../core/http.js";
import { write, insertRow, updateRow } from "../db.js";
import { uuid, moment, label, someKey } from "../shapes.js";
import { bookingsInside } from "../shared/booking.js";
import { dayOf } from "../shared/time.js";
import { TIME_OFF, one, loadRules } from "./rows.js";
import { linkOf } from "./staff.js";
import { needBranch, ownBranch } from "../branches/access.js";

const shape = {
  staffId: uuid.nullable(), // null: the whole business
  start: moment,
  end: moment, // the last minute it covers: all day = 00:00 … 23:59
  note: label(200),
  // Where a closed day is (staffId null): the default branch, or the person's own, when left out.
  // A specialist's time off is where they work.
  branchId: uuid,
};
export const timeOffCreateSchema = z.object(shape).partial().required({ start: true, end: true }).strict();
export const timeOffUpdateSchema = z.object(shape).partial().strict().refine(someKey, "Nothing to change.");

const MAP = { columns: { staffId: "staff_id", start: "start_at", end: "end_at", branchId: "branch_id" }, json: ["note"] };

/** A team member who sees only their own bookings blocks only their own time; one limited to a branch, only its. */
function ownOff(me, staffId, branchId) {
  if (me.only && staffId !== me.only) throw forbidden("You can block only your own time.");
  if (branchId) ownBranch({ branchOnly: me.branch }, branchId);
}
async function cleanOff(c, cfg, v, me) {
  if (v.end < v.start) throw new HttpError(400, "The end must be after the start.", { code: "bad_span" });
  const person = v.staffId && (await c.query("SELECT branch_id FROM crm_staff WHERE workspace_id = $1 AND id = $2", [cfg.workspaceId, v.staffId])).rows[0];
  if (v.staffId && !person) throw new HttpError(400, "This specialist no longer exists.", { code: "bad_staff" });
  if (person) ownOff(me, v.staffId, person.branch_id);
}
/** Open bookings that sit inside the blocked time: { count, ids }. */
async function inside(q, cfg, off) {
  const list = bookingsInside(await loadRules(q, cfg, dayOf(off.start), dayOf(off.end)), off);
  return { count: list.length, ids: list.map((a) => a.id) };
}

/** Blocked time of this workspace this person may change, or 404 (another branch's, for someone limited to one). */
async function getOff(q, cfg, id, me) {
  const stored = await one(q, cfg, "crm_time_off", TIME_OFF, id, "Blocked time");
  if (me.branch && stored.branchId !== me.branch) throw notFound("Blocked time not found");
  return stored;
}

export function createTimeOff(workspaceId, who, input) {
  return write(workspaceId, async (c, cfg, q) => {
    const { branchId: sent, ...v } = { staffId: null, ...input };
    const me = await linkOf(q, workspaceId, who);
    ownOff(me, v.staffId);
    await cleanOff(c, cfg, v, me);
    // A specialist's time off takes their branch in the database (sql/crm/70-branches.sql).
    const branchId = await needBranch(q, cfg, who, sent);
    const rows = await insertRow(c, cfg, "crm_time_off", MAP, TIME_OFF, v, { branch_id: branchId });
    return { changes: { set: { timeOff: rows } }, id: rows[0].id, inside: await inside(q, cfg, rows[0]) };
  });
}

export function updateTimeOff(workspaceId, who, id, sent) {
  return write(workspaceId, async (c, cfg, q) => {
    const me = await linkOf(q, workspaceId, who);
    const stored = await getOff(q, cfg, id, me);
    ownOff(me, stored.staffId);
    // A closed day may move to another branch; a specialist's time off stays where they work.
    const { branchId, ...input } = sent;
    const next = { ...stored, ...input };
    if (branchId && !next.staffId) input.branchId = await needBranch(q, cfg, who, branchId);
    ownOff(me, next.staffId);
    await cleanOff(c, cfg, next, me);
    if (!Object.keys(input).length) return { changes: {}, inside: await inside(q, cfg, stored) };
    const rows = await updateRow(c, cfg, "crm_time_off", MAP, TIME_OFF, id, input);
    return { changes: { set: { timeOff: rows } }, inside: await inside(q, cfg, rows[0]) };
  });
}

export function deleteTimeOff(workspaceId, who, id) {
  return write(workspaceId, async (c, cfg, q) => {
    const me = await linkOf(q, workspaceId, who);
    const stored = await getOff(q, cfg, id, me);
    ownOff(me, stored.staffId);
    await c.query("DELETE FROM crm_time_off WHERE workspace_id = $1 AND id = $2", [workspaceId, id]);
    return { changes: { del: { timeOff: [id] } } };
  });
}
