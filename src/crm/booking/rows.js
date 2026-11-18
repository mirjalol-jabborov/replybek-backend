// How the Booking module's rows read: the columns as the app gets them (the demo's field names,
// moments as "2026-11-17T09:30"), and the loaders every route shares.
import { notFound } from "../../core/http.js";
import { wall, isUuid } from "../db.js";
import { stageIds } from "../shared/index.js";
import { OPEN_KINDS } from "../shared/booking.js";
import { addDays } from "../shared/time.js";
import { branchRules } from "../branches/access.js";

const moment = (col) => `to_char(${col}, 'YYYY-MM-DD"T"HH24:MI')`;
const day = (col) => `to_char(${col}, 'YYYY-MM-DD')`;

export const STAFF = `id, name, role, tone, hours, breaks, service_ids AS "serviceIds", active, user_id AS "userId", own_only AS "ownOnly", branch_id AS "branchId"`;
// Money is whole soʻm in a BIGINT; float8 holds it exactly far past any price.
export const SERVICE = `id, name, category, duration, price::float8 AS price, buffer, active`;
export const TIME_OFF = `id, staff_id AS "staffId", ${moment("start_at")} AS start, ${moment("end_at")} AS "end", note, branch_id AS "branchId"`;
/** `tz`: the parameter holding the workspace's time zone ("$2"), for createdAt. */
export const APPT = (tz) => `id, customer_id AS "customerId", staff_id AS "staffId", service_ids AS "serviceIds", ${moment("start_at")} AS start, duration,
  price::float8 AS price, status, source, note, paid, fields, history, series_id AS "seriesId", ${day("series_day")} AS "seriesDay",
  branch_id AS "branchId", ${wall("created_at", tz)} AS "createdAt", creator AS "createdBy"`;
export const SERIES = `id, customer_id AS "customerId", staff_id AS "staffId", service_ids AS "serviceIds", time_of_day AS time, duration,
  price::float8 AS price, source, note, fields, every, weekdays, ${day("start_day")} AS "startDay", ${day("until")} AS until, count,
  ${day("through")} AS through, skipped, branch_id AS "branchId"`;

/**
 * Bookings in the calendar's order (start, then id), or `newest` first (a customer's panel).
 * `where`, any of: `ids`; `from`, `to` (days, both included); `open` (step ids: with `from`, the
 * bookings in these steps come too, whatever their day); `staffId`; `customerId`; `branchId`; `after`
 * (a booking's id: the ones after it in the calendar's order, for the next page); `limit`. Each part
 * is an index range or a filter on one (crm_appointments_workspace, _status, _staff, _customer, _branch).
 */
export async function listAppointments(q, cfg, where = {}) {
  if (where.ids && !where.ids.length) return [];
  const params = [cfg.workspaceId, cfg.timezone];
  const and = ["workspace_id = $1"];
  const add = (sql, ...values) => and.push(values.reduce((text, v) => text.replace("$x", `$${params.push(v)}`), sql));
  if (where.ids) add("id = ANY($x::uuid[])", where.ids);
  if (where.from && where.open) add("(start_at >= $x::date OR status = ANY($x::text[]))", where.from, where.open);
  else if (where.from) add("start_at >= $x::date", where.from);
  if (where.to) add("start_at < $x::date + 1", where.to);
  if (where.staffId) add("staff_id = $x", where.staffId);
  if (where.customerId) add("customer_id = $x", where.customerId);
  if (where.branchId) add("branch_id = $x", where.branchId);
  if (where.after) add("(start_at, id) > (SELECT start_at, id FROM crm_appointments WHERE workspace_id = $1 AND id = $x)", where.after);
  const { rows } = await q(
    `SELECT ${APPT("$2")} FROM crm_appointments WHERE ${and.join(" AND ")}
      ORDER BY ${where.newest ? "start_at DESC, id" : "start_at, id"} ${where.limit ? `LIMIT ${Number(where.limit)}` : ""}`,
    params
  );
  return rows;
}

/** One row of this workspace by id, or 404. Another workspace's id reads as "not found". */
export async function one(q, cfg, table, cols, id, what) {
  const { rows } = isUuid(id) ? await q(`SELECT ${cols} FROM ${table} WHERE workspace_id = $1 AND id = $2`, [cfg.workspaceId, id]) : { rows: [] };
  if (!rows[0]) throw notFound(`${what} not found`);
  return rows[0];
}

/**
 * The data the rules read, fresh: the team, services, time off, the bookings that start
 * between two days (both included), and the branches' own hours. The shape check() and freeStarts() take.
 */
export async function loadRules(q, cfg, from, to) {
  const w = cfg.workspaceId;
  // One after another: inside a write they share the transaction's one connection.
  const rows = async (text, params) => (await q(text, params)).rows;
  const staff = await rows(`SELECT ${STAFF} FROM crm_staff WHERE workspace_id = $1 ORDER BY created_at, id`, [w]);
  const services = await rows(`SELECT ${SERVICE} FROM crm_services WHERE workspace_id = $1 ORDER BY created_at, id`, [w]);
  const timeOff = await rows(`SELECT ${TIME_OFF} FROM crm_time_off WHERE workspace_id = $1 AND end_at >= $2::date AND start_at < $3::date ORDER BY start_at, id`, [w, from, addDays(to, 1)]);
  const appointments = await rows(`SELECT ${APPT("$4")} FROM crm_appointments WHERE workspace_id = $1 AND start_at >= $2::date AND start_at < $3::date ORDER BY start_at, id`, [w, from, addDays(to, 1), cfg.timezone]);
  const branches = await branchRules(q, cfg);
  return { settings: cfg.data.settings, apptStages: cfg.data.apptStages, staff, services, timeOff, appointments, branches };
}

/**
 * Bookings still ahead (or going on now) in an open step: the shared upcoming(), in one query.
 * Narrowed to one specialist or to one service when asked.
 */
export async function upcomingOf(q, cfg, { staffId = null, serviceId = null } = {}) {
  const { rows } = await q(
    `SELECT ${APPT("$3")} FROM crm_appointments
      WHERE workspace_id = $1 AND status = ANY($2::text[])
        -- A visit lasts a day at most, so this keeps the index on start_at in use.
        AND start_at > $4::timestamp - interval '1 day' AND start_at + make_interval(mins => duration) > $4::timestamp
        AND ($5::uuid IS NULL OR staff_id = $5) AND ($6::uuid IS NULL OR $6 = ANY(service_ids))
      ORDER BY start_at, id`,
    [cfg.workspaceId, stageIds(cfg.data.apptStages, ...OPEN_KINDS), cfg.timezone, cfg.now, staffId, serviceId]
  );
  return rows;
}
