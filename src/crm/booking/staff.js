// The team: who can be booked, when they work, what they do, and which login (if any) they are.
// Setting it up is for admins.
import { z } from "zod";
import { HttpError } from "../../core/http.js";
import { write, insertRow, updateRow } from "../db.js";
import { uuid, uuids, hm, hmEnd, label, someKey } from "../shapes.js";
import { check } from "../shared/booking.js";
import { STAFF, APPT, one, upcomingOf } from "./rows.js";

/**
 * What the signed-in person is to the Booking module: { staffId, only }.
 * staffId: the specialist they are, if any. only: that same id when they may see and change
 * nothing but their own bookings (a team member with ownOnly; admins and the owner see all).
 */
export async function linkOf(q, workspaceId, who) {
  const { rows } = await q("SELECT id, own_only FROM crm_staff WHERE workspace_id = $1 AND user_id = $2", [workspaceId, who.user.id]);
  const staffId = rows[0]?.id || null;
  return { staffId, only: staffId && rows[0].own_only && who.role === "agent" ? staffId : null };
}

const dayHours = z.union([z.null(), z.tuple([hm, hmEnd]).refine(([from, to]) => from < to, "The working day must end after it starts.")]);
const shape = {
  name: z.string().trim().min(1, "Add the specialist's name.").max(120),
  role: label(120),
  tone: z.enum(["t1", "t2", "t3", "t4", "t5", "t6"]),
  // Every weekday, 0 = Sunday: ["10:00", "20:00"] or null for a day off.
  hours: z.object({ 0: dayHours, 1: dayHours, 2: dayHours, 3: dayHours, 4: dayHours, 5: dayHours, 6: dayHours }).strict(),
  breaks: z
    .array(z.object({ from: hm, to: hm }).strict().refine((b) => b.from < b.to, "A break must end after it starts."))
    .max(10)
    .transform((list) => [...list].sort((a, b) => (a.from < b.from ? -1 : 1))),
  serviceIds: uuids(500),
  active: z.boolean(),
  userId: uuid.nullable(),
  ownOnly: z.boolean(),
};
export const staffCreateSchema = z.object(shape).partial().required({ name: true, hours: true }).strict();
export const staffUpdateSchema = z.object(shape).partial().strict().refine(someKey, "Nothing to change.");

const MAP = { columns: { serviceIds: "service_ids", userId: "user_id", ownOnly: "own_only" }, json: ["role", "hours", "breaks"] };
const brief = (list) => ({ count: list.length, ids: list.map((a) => a.id) });
// The reasons new hours or breaks can give a booking that was fine before.
const HOURS_REASONS = ["day_off", "outside_hours", "break"];

async function cleanStaff(c, cfg, v, id) {
  if (v.serviceIds?.length) {
    const { rows } = await c.query("SELECT id FROM crm_services WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [cfg.workspaceId, v.serviceIds]);
    if (rows.length !== v.serviceIds.length) throw new HttpError(400, "One of the services no longer exists.", { code: "bad_service" });
  }
  if (v.userId) {
    const member = (await c.query("SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2", [cfg.workspaceId, v.userId])).rows[0];
    if (!member) throw new HttpError(400, "Choose someone from the team.", { code: "bad_user" });
    const twin = (await c.query("SELECT id, name FROM crm_staff WHERE workspace_id = $1 AND user_id = $2 AND id IS DISTINCT FROM $3", [cfg.workspaceId, v.userId, id || null])).rows[0];
    if (twin) throw new HttpError(409, `This team member is already linked to ${twin.name}.`, { code: "user_taken", staffId: twin.id });
  }
}

export function createStaff(workspaceId, input) {
  return write(workspaceId, async (c, cfg) => {
    await cleanStaff(c, cfg, input);
    const rows = await insertRow(c, cfg, "crm_staff", MAP, STAFF, input, { branch_id: cfg.branchId });
    return { changes: { set: { staff: rows } }, id: rows[0].id };
  });
}

/**
 * Saves a specialist. Someone with bookings still ahead can't be switched off: those bookings
 * would stay on the calendar with nobody to take them. New hours or breaks are saved as they
 * are; the answer lists the bookings ahead that no longer fit them (`outside`), which stay put.
 */
export function updateStaff(workspaceId, id, input) {
  return write(workspaceId, async (c, cfg, q) => {
    const stored = await one(q, cfg, "crm_staff", STAFF, id, "Specialist");
    await cleanStaff(c, cfg, input, id);
    const mine = await upcomingOf(q, cfg, { staffId: id });
    if (input.active === false && stored.active && mine.length) {
      throw new HttpError(409, `${stored.name} has bookings ahead. Move them to someone else or cancel them first.`, { code: "staff_has_bookings", ...brief(mine) });
    }
    const rows = await updateRow(c, cfg, "crm_staff", MAP, STAFF, id, input);
    const out = { changes: { set: { staff: rows } } };
    if (input.hours || input.breaks) {
      // Only the person's own hours and breaks are asked about, so the rest of the data can stay out.
      const db = { settings: cfg.data.settings, apptStages: cfg.data.apptStages, staff: rows, services: [], timeOff: [], appointments: [] };
      out.outside = brief(mine.filter((a) => check(db, a, { by: "team", now: cfg.now }).soft.some((r) => HOURS_REASONS.includes(r.code))));
    }
    return out;
  });
}

/** Deletes a specialist nobody was ever booked with. One with bookings stays, and can be switched off instead. */
export function deleteStaff(workspaceId, id) {
  return write(workspaceId, async (c, cfg, q) => {
    const stored = await one(q, cfg, "crm_staff", STAFF, id, "Specialist");
    const n = (await c.query("SELECT count(*)::int AS n FROM crm_appointments WHERE workspace_id = $1 AND staff_id = $2", [workspaceId, id])).rows[0].n;
    if (n) throw new HttpError(409, `${stored.name} has bookings, so they can't be deleted. Switch them off instead.`, { code: "staff_has_bookings", count: n });
    // Their time off and repeat bookings go with them (ON DELETE CASCADE). A series can name them
    // with none of its visits booked (changed to them, every day skipped): its visits with
    // others stay, as ordinary bookings.
    const ids = async (table) => (await c.query(`SELECT id FROM ${table} WHERE workspace_id = $1 AND staff_id = $2`, [workspaceId, id])).rows.map((r) => r.id);
    const timeOff = await ids("crm_time_off");
    const series = await ids("crm_series");
    const unlinked = series.length
      ? (await c.query(`UPDATE crm_appointments SET series_id = NULL, series_day = NULL WHERE workspace_id = $1 AND series_id = ANY($2::uuid[]) RETURNING ${APPT("$3")}`, [workspaceId, series, cfg.timezone])).rows
      : [];
    await c.query("DELETE FROM crm_staff WHERE workspace_id = $1 AND id = $2", [workspaceId, id]);
    return {
      changes: {
        del: { staff: [id], ...(timeOff.length ? { timeOff } : {}), ...(series.length ? { series } : {}) },
        ...(unlinked.length ? { set: { appointments: unlinked } } : {}),
      },
    };
  });
}
