// The Booking module: the team, services, time off, bookings and repeat bookings.
// What a module exports is described in ../modules.js; the routes are in routes.js.
// A team member linked to a specialist with ownOnly sees only their own bookings, in the
// snapshot and in a customer's history too.
import { APPT, SERIES, STAFF, SERVICE, TIME_OFF } from "./rows.js";
import { linkOf } from "./staff.js";
import { stageIds } from "../shared/index.js";
import { OPEN_KINDS } from "../shared/booking-steps.js";
import "./series-job.js"; // registers the daily job that books what comes into view

export { router } from "./routes.js";
export const keys = ["staff", "services", "timeOff", "appointments", "series"];

// What the public pages and the AI agent's bridge ask Booking for: bookings a customer makes,
// moves and cancels themselves (`who` = { by: "customer", ... }, see appointments.js), and the
// rows the free times are read from.
export { bookAppointment, editAppointment, getAppointment, bookedByCustomerToday } from "./appointments.js";
export { cancelAppointment } from "./steps.js";
export { loadRules } from "./rows.js";

// What the signed-in person is to Booking, read once per snapshot or history (me() and snapshot() share a ctx).
const links = new WeakMap();
const linkFor = (ctx) => {
  if (!links.has(ctx)) links.set(ctx, linkOf(ctx.q, ctx.cfg.workspaceId, { user: ctx.user, role: ctx.role }));
  return links.get(ctx);
};

/** What the signed-in person is to Booking: the specialist they are linked to, if any. */
export async function me(ctx) {
  return { staffId: (await linkFor(ctx)).staffId };
}

/**
 * The module's part of the snapshot: one query per key asked for. `ctx.branchId`: narrowed to one
 * branch (?branch=, or a team member limited to one): its team, time off, bookings and series.
 */
export async function snapshot(ctx) {
  const { q, cfg, want } = ctx;
  const w = cfg.workspaceId;
  const b = ctx.branchId || null;
  const out = {};
  const rows = async (key, text, params) => {
    if (want(key)) out[key] = (await q(text, params)).rows;
  };
  await rows("staff", `SELECT ${STAFF} FROM crm_staff WHERE workspace_id = $1 AND ($2::uuid IS NULL OR branch_id = $2) ORDER BY created_at, id`, [w, b]);
  await rows("services", `SELECT ${SERVICE} FROM crm_services WHERE workspace_id = $1 ORDER BY created_at, id`, [w]);
  await rows("timeOff", `SELECT ${TIME_OFF} FROM crm_time_off WHERE workspace_id = $1 AND ($2::uuid IS NULL OR branch_id = $2) ORDER BY start_at, id`, [w, b]);
  if (want("appointments") || want("series")) {
    const { only } = await linkFor(ctx);
    await rows("appointments", `SELECT ${APPT("$2")} FROM crm_appointments WHERE workspace_id = $1 AND ($3::uuid IS NULL OR staff_id = $3) AND ($4::uuid IS NULL OR branch_id = $4) ORDER BY start_at, id`, [w, cfg.timezone, only, b]);
    await rows("series", `SELECT ${SERIES} FROM crm_series WHERE workspace_id = $1 AND ($2::uuid IS NULL OR staff_id = $2) AND ($3::uuid IS NULL OR branch_id = $3) ORDER BY created_at, id`, [w, only, b]);
  }
  return out;
}

/** How many bookings (or services) use these ids of a settings list: { [id]: n }. */
export async function countUses(c, workspaceId, list, ids) {
  const by = { apptStages: ["crm_appointments", "status"], sources: ["crm_appointments", "source"], serviceCategories: ["crm_services", "category"] }[list];
  if (!by || !ids.length) return {};
  const { rows } = await c.query(`SELECT ${by[1]} AS id, count(*)::int AS n FROM ${by[0]} WHERE workspace_id = $1 AND ${by[1]} = ANY($2::text[]) GROUP BY 1`, [workspaceId, ids]);
  return Object.fromEntries(rows.map((r) => [r.id, r.n]));
}

/**
 * A step of the bookings board was removed: its bookings move to another step. Core has checked
 * that both steps mean the same (the same kind), so no time is freed or taken by this.
 */
export async function moveStage(c, cfg, list, from, to) {
  if (list !== "apptStages") return null;
  const { rows } = await c.query(`UPDATE crm_appointments SET status = $3 WHERE workspace_id = $1 AND status = $2 RETURNING ${APPT("$4")}`, [cfg.workspaceId, from, to, cfg.timezone]);
  return rows.length ? { set: { appointments: rows } } : null;
}

/**
 * What still goes on at a branch: open bookings (waiting, confirmed, in progress) that haven't
 * ended, and repeat bookings with no last day or one today or later. A visit is at most a day
 * long, so the bookings are read from a day before now on the branch's index.
 */
export async function branchUses(c, cfg, branchId) {
  const { rows } = await c.query(
    `SELECT (SELECT count(*)::int FROM crm_appointments WHERE workspace_id = $1 AND branch_id = $2 AND status = ANY($3::text[])
                AND start_at >= $4::timestamp - interval '1 day' AND start_at + make_interval(mins => duration) > $4::timestamp) AS appointments,
            (SELECT count(*)::int FROM crm_series WHERE workspace_id = $1 AND branch_id = $2 AND (until IS NULL OR until >= $4::timestamp::date)) AS series`,
    [cfg.workspaceId, branchId, stageIds(cfg.data.apptStages, ...OPEN_KINDS), cfg.now]
  );
  return rows[0];
}

/**
 * A customer's bookings and repeat bookings: with any, the customer can't be deleted. A series
 * counts even when its visits are gone, since deleting the customer would take it along unasked.
 */
export async function customerUses(c, workspaceId, customerId) {
  const { rows } = await c.query(
    `SELECT (SELECT count(*)::int FROM crm_appointments WHERE workspace_id = $1 AND customer_id = $2) AS appointments,
            (SELECT count(*)::int FROM crm_series WHERE workspace_id = $1 AND customer_id = $2) AS series`,
    [workspaceId, customerId]
  );
  return rows[0];
}

/** A customer's bookings for their panel, newest first (one branch's, for a team member limited to it). */
export async function customerHistory(ctx, customerId) {
  const { only } = await linkFor(ctx);
  const { rows } = await ctx.q(
    `SELECT ${APPT("$3")} FROM crm_appointments WHERE workspace_id = $1 AND customer_id = $2 AND ($4::uuid IS NULL OR staff_id = $4) AND ($5::uuid IS NULL OR branch_id = $5)
      ORDER BY start_at DESC, id`,
    [ctx.cfg.workspaceId, customerId, ctx.cfg.timezone, only, ctx.branchId || null]
  );
  return { appointments: rows };
}
