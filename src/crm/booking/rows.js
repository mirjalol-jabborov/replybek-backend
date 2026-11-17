// How the Booking module's rows read: the columns as the app gets them (the demo's field names,
// moments as "2026-11-17T09:30"), and the loaders every route shares.
import { HttpError, notFound } from "../../lib/http.js";
import { wall } from "../db.js";
import { stageIds } from "../shared/index.js";
import { OPEN_KINDS } from "../shared/booking.js";
import { addDays } from "../shared/time.js";

const moment = (col) => `to_char(${col}, 'YYYY-MM-DD"T"HH24:MI')`;
const day = (col) => `to_char(${col}, 'YYYY-MM-DD')`;

export const STAFF = `id, name, role, tone, hours, breaks, service_ids AS "serviceIds", active, user_id AS "userId", own_only AS "ownOnly", branch_id AS "branchId"`;
// Money is whole soʻm in a BIGINT; float8 holds it exactly far past any price.
export const SERVICE = `id, name, category, duration, price::float8 AS price, buffer, active`;
export const TIME_OFF = `id, staff_id AS "staffId", ${moment("start_at")} AS start, ${moment("end_at")} AS "end", note, branch_id AS "branchId"`;
/** `tz`: the parameter holding the workspace's time zone ("$2"), for createdAt. */
export const APPT = (tz) => `id, customer_id AS "customerId", staff_id AS "staffId", service_ids AS "serviceIds", ${moment("start_at")} AS start, duration,
  price::float8 AS price, status, source, note, paid, fields, history, series_id AS "seriesId", ${day("series_day")} AS "seriesDay",
  branch_id AS "branchId", ${wall("created_at", tz)} AS "createdAt"`;
export const SERIES = `id, customer_id AS "customerId", staff_id AS "staffId", service_ids AS "serviceIds", time_of_day AS time, duration,
  price::float8 AS price, source, note, fields, every, weekdays, ${day("start_day")} AS "startDay", ${day("until")} AS until, count,
  ${day("through")} AS through, skipped, branch_id AS "branchId"`;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A client inside a transaction as the plain q(text, params) the loaders take. */
export const asQ = (c) => (text, params) => c.query(text, params);

/** One row of this workspace by id, or 404. Another workspace's id reads as "not found". */
export async function one(q, cfg, table, cols, id, what) {
  const { rows } = UUID.test(id) ? await q(`SELECT ${cols} FROM ${table} WHERE workspace_id = $1 AND id = $2`, [cfg.workspaceId, id]) : { rows: [] };
  if (!rows[0]) throw notFound(`${what} not found`);
  return rows[0];
}

/**
 * How an entity's fields are stored: `columns` maps a field to its column where the names differ,
 * `json` lists the fields kept as JSONB.
 */
function stored(map, v) {
  const keys = Object.keys(v);
  return { cols: keys.map((k) => map.columns?.[k] || k), values: keys.map((k) => (map.json?.includes(k) ? JSON.stringify(v[k]) : v[k])) };
}
/** INSERT of the fields in `v` plus the `base` columns; returns the new row as `ret` reads it. */
export function insertRow(c, table, map, ret, base, v) {
  const { cols, values } = stored(map, v);
  const all = [...Object.keys(base), ...cols];
  return c.query(`INSERT INTO ${table} (${all.join(", ")}) VALUES (${all.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING ${ret}`, [...Object.values(base), ...values]);
}
/** UPDATE of the fields in `v` on one row of the workspace. */
export function updateRow(c, table, map, ret, workspaceId, id, v) {
  const { cols, values } = stored(map, v);
  return c.query(`UPDATE ${table} SET ${cols.map((k, i) => `${k} = $${i + 3}`).join(", ")} WHERE workspace_id = $1 AND id = $2 RETURNING ${ret}`, [workspaceId, id, ...values]);
}

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

/**
 * The data the rules read, fresh: the team, services, time off, and the bookings that start
 * between two days (both included). The shape check() and freeStarts() take.
 */
export async function loadRules(q, cfg, from, to) {
  const w = cfg.workspaceId;
  // One after another: inside a write they share the transaction's one connection.
  const rows = async (text, params) => (await q(text, params)).rows;
  const staff = await rows(`SELECT ${STAFF} FROM crm_staff WHERE workspace_id = $1 ORDER BY created_at, id`, [w]);
  const services = await rows(`SELECT ${SERVICE} FROM crm_services WHERE workspace_id = $1 ORDER BY created_at, id`, [w]);
  const timeOff = await rows(`SELECT ${TIME_OFF} FROM crm_time_off WHERE workspace_id = $1 AND end_at >= $2::date AND start_at < $3::date ORDER BY start_at, id`, [w, from, addDays(to, 1)]);
  const appointments = await rows(`SELECT ${APPT("$4")} FROM crm_appointments WHERE workspace_id = $1 AND start_at >= $2::date AND start_at < $3::date ORDER BY start_at, id`, [w, from, addDays(to, 1), cfg.timezone]);
  return { settings: cfg.data.settings, apptStages: cfg.data.apptStages, staff, services, timeOff, appointments };
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

/**
 * A rule refusal: 422 { code: "rules", hard, soft, override }. `override` says whether force could
 * pass the soft ones. The app speaks from the codes; `message` is for logs and API callers.
 */
export const refusal = (cfg, result, message = result.hard.length ? "This time can't be booked." : "This time is outside the booking rules.") =>
  new HttpError(422, message, {
    code: "rules",
    hard: result.hard,
    soft: result.soft,
    override: cfg.data.settings.rules?.override !== false,
  });
