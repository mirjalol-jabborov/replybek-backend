// Repeat bookings: a visit that comes back every N weeks on some weekdays. A series only says
// what repeats; the visits themselves are ordinary bookings, made up to rules.maxDays ahead and
// each checked like any booking. A day that can't be booked is never forced: it is skipped and
// listed with its reasons, so someone can decide what to do with it. A daily job books the days
// that come into view.
import { z } from "zod";
import { query } from "../../db.js";
import { HttpError, forbidden, notFound } from "../../lib/http.js";
import { registerJob } from "../../services/jobs.service.js";
import { write } from "../db.js";
import { kindOf, firstOf } from "../shared/index.js";
import { check, isClean, totals, startStage, kindHolds, rulesOf, seriesDays, seriesEnded } from "../shared/booking.js";
import { dayOf, hmOf, at, addDays, weekday } from "../shared/time.js";
import { uuid, serviceList, day, hm, money, minutes, label } from "./shapes.js";
import { SERIES, APPT, UUID, asQ, linkOf, loadRules } from "./rows.js";
import { getAppointment, insertAppointment, saveAppointment, entry } from "./appointments.js";

/* ───── Shapes ───── */

const pattern = {
  every: z.number().int().min(1).max(52), // weeks
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).transform((d) => [...new Set(d)].sort()),
  until: day.nullable(), // the last day it may fall on
  count: z.number().int().min(1).max(520).nullable(), // or how many visits in all
};
const oneEnd = (v) => !(v.until && v.count);
export const seriesCreateSchema = z
  .object({ appointmentId: uuid, ...pattern })
  .partial()
  .required({ appointmentId: true })
  .strict()
  .refine(oneEnd, "Give the last day or the number of visits, not both.");
export const seriesChangeSchema = z
  .object({
    from: day, // this day's visit and all later ones
    staffId: uuid,
    serviceIds: serviceList,
    time: hm,
    duration: minutes,
    price: money,
    note: label(2000),
    ...pattern,
  })
  .partial()
  .required({ from: true })
  .strict()
  .refine(oneEnd, "Give the last day or the number of visits, not both.")
  .refine((v) => Object.keys(v).length > 1, "Nothing to change.");
export const seriesStopSchema = z.object({ from: day, reason: z.string().trim().max(500).optional() }).strict();

/* ───── Shared pieces ───── */

const KEEP_SKIPPED = 60;
// Only visits nobody has started on, from today on, follow the series: one that is going on,
// finished, closed or in the past stays as it is.
const FOLLOWS = ["pending", "booked"];
const follows = (cfg, v) => FOLLOWS.includes(kindOf(cfg.data.apptStages, v.status)) && v.seriesDay >= dayOf(cfg.now);
// A visit someone moved "only this one" to another specialist is that person's now: a team
// member who works only with their own bookings leaves it as it is.
const theirs = (me, v) => Boolean(me.only) && v.staffId !== me.only;

async function getSeries(q, cfg, id, me) {
  const { rows } = UUID.test(id) ? await q(`SELECT ${SERIES} FROM crm_series WHERE workspace_id = $1 AND id = $2`, [cfg.workspaceId, id]) : { rows: [] };
  if (!rows[0] || (me?.only && rows[0].staffId !== me.only)) throw notFound("Repeat booking not found");
  return rows[0];
}
const horizonOf = (cfg) => addDays(dayOf(cfg.now), rulesOf({ settings: cfg.data.settings }).maxDays || 30);
const visitsOf = async (c, cfg, id, from) =>
  (await c.query(`SELECT ${APPT("$4")} FROM crm_appointments WHERE workspace_id = $1 AND series_id = $2 AND series_day >= $3::date ORDER BY series_day`, [cfg.workspaceId, id, from, cfg.timezone])).rows;

/**
 * Books one day of a series, if the rules allow it with no reasons at all.
 * Returns { row } or { skip: { day, hard, soft } }. `db` (the rules' data) gains the new booking.
 */
async function bookDay(c, cfg, db, s, on, stage, createdBy) {
  const draft = { staffId: s.staffId, serviceIds: s.serviceIds, start: at(on, s.time), duration: s.duration };
  const result = check(db, draft, { by: "team", now: cfg.now });
  if (!isClean(result)) return { skip: { day: on, ...result } };
  try {
    const row = await insertAppointment(c, cfg, {
      ...draft, customerId: s.customerId, price: s.price, status: stage.id, busy: kindHolds(stage.kind), source: s.source, note: s.note, fields: s.fields,
      seriesId: s.id, seriesDay: on, createdBy,
    });
    db.appointments.push(row);
    return { row };
  } catch (e) {
    // The database refused a double booking the rules didn't see: skipped like any other reason.
    if (e.status === 422 && e.extra?.code === "rules") return { skip: { day: on, hard: e.extra.hard, soft: e.extra.soft } };
    throw e;
  }
}

/**
 * Books the days of a series that have come into view: after `through`, up to rules.maxDays
 * ahead. A day that has a visit of the series already is left alone: after maxDays was lowered,
 * a change sets `through` back to the horizon while visits further ahead stay.
 * Returns { series (as stored now), created: [rows], skipped: [{ day, hard, soft }] }.
 */
async function extend(c, cfg, s, createdBy) {
  const today = dayOf(cfg.now);
  const horizon = horizonOf(cfg);
  if (horizon <= s.through) return { series: s, created: [], skipped: [] };
  const first = addDays(s.through, 1);
  const have = new Set(
    (await c.query(`SELECT to_char(series_day, 'YYYY-MM-DD') AS day FROM crm_appointments WHERE workspace_id = $1 AND series_id = $2 AND series_day > $3::date`, [cfg.workspaceId, s.id, s.through])).rows.map((r) => r.day)
  );
  const days = seriesDays(s, first > today ? first : today, horizon).filter((d) => !have.has(d));
  const created = [];
  const skipped = [];
  if (days.length) {
    const stage = startStage(cfg.data.apptStages, "team");
    const db = await loadRules(asQ(c), cfg, days[0], days[days.length - 1]);
    for (const on of days) {
      const r = stage ? await bookDay(c, cfg, db, s, on, stage, createdBy) : { skip: { day: on, hard: [{ code: "no_steps" }], soft: [] } };
      if (r.row) created.push(r.row);
      else skipped.push(r.skip);
    }
  }
  const { rows } = await c.query(`UPDATE crm_series SET through = $3, skipped = $4 WHERE workspace_id = $1 AND id = $2 RETURNING ${SERIES}`, [
    cfg.workspaceId, s.id, horizon, JSON.stringify([...s.skipped, ...skipped].slice(-KEEP_SKIPPED)),
  ]);
  return { series: rows[0], created, skipped };
}

/* ───── Writes ───── */

/**
 * Makes a booking repeat. The booking becomes the first visit of the series; the next ones are
 * booked now, as far ahead as customers may book. Answers with what was booked and what wasn't:
 * { changes, id, created: [appointment ids], skipped: [{ day, hard, soft }] }.
 */
export function createSeries(workspaceId, who, body) {
  return write(workspaceId, async (c, cfg) => {
    const q = asQ(c);
    const a = await getAppointment(q, cfg, body.appointmentId, await linkOf(q, workspaceId, who));
    if (a.seriesId) throw new HttpError(409, "This booking already repeats.", { code: "in_series", seriesId: a.seriesId });
    if (!kindHolds(kindOf(cfg.data.apptStages, a.status))) throw new HttpError(409, "A cancelled or missed booking can't repeat. Restore it first.", { code: "booking_closed" });
    const first = dayOf(a.start);
    const weekdays = body.weekdays || [weekday(first)];
    if (!weekdays.includes(weekday(first))) throw new HttpError(400, "The weekdays must include the day of this booking.", { code: "bad_weekdays" });
    if (body.until && body.until <= first) throw new HttpError(400, "The last day must be after this booking.", { code: "bad_until" });
    const { rows } = await c.query(
      `INSERT INTO crm_series (workspace_id, branch_id, customer_id, staff_id, service_ids, time_of_day, duration, price, source, note, fields, every, weekdays, start_day, until, count, through, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $14, $17) RETURNING ${SERIES}`,
      [workspaceId, cfg.branchId, a.customerId, a.staffId, a.serviceIds, hmOf(a.start), a.duration, a.price, a.source, JSON.stringify(a.note), JSON.stringify(a.fields), body.every || 1, weekdays, first, body.until || null, body.count || null, who.user.id]
    );
    const anchor = (await c.query(`UPDATE crm_appointments SET series_id = $3, series_day = $4 WHERE workspace_id = $1 AND id = $2 RETURNING ${APPT("$5")}`, [workspaceId, a.id, rows[0].id, first, cfg.timezone])).rows[0];
    const { series, created, skipped } = await extend(c, cfg, rows[0], who.user.id);
    await keepExtending(c);
    return { changes: { set: { series: [series], appointments: [anchor, ...created] } }, id: series.id, created: created.map((r) => r.id), skipped };
  });
}

/**
 * Changes a visit of a series and all later ones ("only this one" is an ordinary edit of that
 * booking). From `from` on, the series is what the body says. Visits not started yet follow:
 * a day that stays in the pattern moves to the new time, specialist and services if the rules
 * allow it with no reasons (else it stays as it was, and is listed with `kept: true`); a day
 * that left the pattern is removed; a new day is booked like any day of a series, up to
 * rules.maxDays ahead (the daily job books the ones further on). Visits booked further ahead
 * than that (maxDays was larger then) stay and follow the change too.
 * `from` must be a day of the series: the day of one of its visits, or a day of its pattern.
 * Answers { changes, created: [ids], moved: [ids], removed: [ids], skipped: [{ day, hard, soft, id?, kept? }] }.
 */
export function changeSeries(workspaceId, who, id, body) {
  return write(workspaceId, async (c, cfg) => {
    const q = asQ(c);
    const me = await linkOf(q, workspaceId, who);
    const s = await getSeries(q, cfg, id, me);
    const { from, ...patch } = body;
    if (s.until && from > s.until) throw new HttpError(409, "This repeat booking has ended.", { code: "series_ended" });
    // The visits before `from` are behind this change: the count that is left starts at `from`.
    const passed = s.count ? seriesDays(s, s.startDay, addDays(from, -1)).length : 0;
    if (s.count && passed >= s.count) throw new HttpError(409, "This repeat booking has ended.", { code: "series_ended" });
    const visits = await visitsOf(c, cfg, id, from);
    // Any other day would put an every-N-weeks series on other weeks, or book days before it began.
    const ownDay = visits[0]?.seriesDay === from || (from >= s.startDay && seriesDays(s, from, from).length === 1);
    if (!ownDay) throw new HttpError(400, "Choose one of the visits of this repeat booking.", { code: "bad_from" });
    if (patch.staffId && me.only && patch.staffId !== me.only) throw forbidden("You can book only for yourself.");
    const today = dayOf(cfg.now);
    const horizon = horizonOf(cfg);
    const latest = (d, x) => (x && x > d ? x : d);
    // How far the series reaches now: the horizon, or further when visits were booked further ahead.
    const reach = visits.reduce((d, v) => latest(d, v.seriesDay), latest(horizon, s.through));
    const lastDay = visits.reduce((d, v) => latest(d, dayOf(v.start)), reach);
    const db = await loadRules(q, cfg, from < today ? from : today, lastDay);
    if (patch.staffId && !db.staff.some((p) => p.id === patch.staffId)) throw new HttpError(400, "This specialist no longer exists.", { code: "bad_staff" });
    if (patch.serviceIds && patch.serviceIds.some((x) => !db.services.some((v) => v.id === x))) throw new HttpError(400, "One of the services no longer exists.", { code: "bad_service" });
    // New services bring their own length and price, unless the caller says otherwise.
    const sum = patch.serviceIds ? totals(db, patch.serviceIds) : null;
    const until = patch.until !== undefined ? patch.until : patch.count ? null : s.until;
    const count = patch.count !== undefined ? patch.count : patch.until ? null : s.count ? s.count - passed : null;
    if (until && until < from) throw new HttpError(400, "The last day must not be before this visit.", { code: "bad_until" });
    const next = {
      ...s, ...patch, startDay: from, until, count,
      duration: patch.duration ?? (sum ? sum.duration : s.duration),
      price: patch.price ?? (sum ? sum.price : s.price),
    };
    const days = seriesDays(next, from > today ? from : today, reach);
    const stage = startStage(cfg.data.apptStages, "team");
    const out = { created: [], moved: [], removed: [], skipped: [] };
    const set = [];

    // Days that left the pattern: their visits go, unless someone has started on them.
    for (const v of visits) {
      if (days.includes(v.seriesDay) || !follows(cfg, v) || theirs(me, v)) continue;
      await c.query("DELETE FROM crm_appointments WHERE workspace_id = $1 AND id = $2", [workspaceId, v.id]);
      db.appointments = db.appointments.filter((x) => x.id !== v.id);
      out.removed.push(v.id);
    }
    for (const on of days) {
      const v = visits.find((x) => x.seriesDay === on);
      if (!v) {
        // Past the horizon, the daily job books it once it comes into view.
        if (on > horizon) continue;
        const r = stage ? await bookDay(c, cfg, db, next, on, stage, who.user.id) : { skip: { day: on, hard: [{ code: "no_steps" }], soft: [] } };
        if (r.row) set.push(r.row), out.created.push(r.row.id);
        else out.skipped.push(r.skip);
        continue;
      }
      if (!follows(cfg, v) || theirs(me, v)) continue;
      const target = { staffId: next.staffId, serviceIds: next.serviceIds, start: at(on, next.time), duration: next.duration };
      const sameTime = v.staffId === target.staffId && v.start === target.start && v.duration === target.duration && v.serviceIds.join() === target.serviceIds.join();
      const result = sameTime ? { hard: [], soft: [] } : check(db, { ...target, ignoreId: v.id }, { by: "team", now: cfg.now });
      // A visit booked when customers could book further ahead keeps its day: max_days is not about it.
      result.soft = result.soft.filter((r) => r.code !== "max_days");
      if (!isClean(result)) {
        out.skipped.push({ day: on, id: v.id, kept: true, ...result });
        continue;
      }
      const change = { price: next.price, note: next.note };
      if (!sameTime) Object.assign(change, target, { history: [...v.history, entry(cfg, who, { type: "moved", from: v.start, to: target.start, fromStaff: v.staffId, toStaff: target.staffId })] });
      try {
        const row = await saveAppointment(c, cfg, v, change);
        db.appointments = db.appointments.map((x) => (x.id === row.id ? row : x));
        set.push(row);
        if (!sameTime) out.moved.push(row.id);
      } catch (e) {
        if (e.status !== 422 || e.extra?.code !== "rules") throw e;
        out.skipped.push({ day: on, id: v.id, kept: true, hard: e.extra.hard, soft: e.extra.soft });
      }
    }
    const kept = s.skipped.filter((x) => x.day < from);
    // Booked through the horizon now. Visits further ahead stay, and the days between them that the
    // new pattern has are booked by the daily job, which passes over days that have a visit already.
    const { rows } = await c.query(
      `UPDATE crm_series SET staff_id = $3, service_ids = $4, time_of_day = $5, duration = $6, price = $7, note = $8, every = $9, weekdays = $10,
              start_day = $11, until = $12, count = $13, through = $14::date, skipped = $15
        WHERE workspace_id = $1 AND id = $2 RETURNING ${SERIES}`,
      [workspaceId, id, next.staffId, next.serviceIds, next.time, next.duration, next.price, JSON.stringify(next.note), next.every, next.weekdays, from, until, count, horizon, JSON.stringify([...kept, ...out.skipped].slice(-KEEP_SKIPPED))]
    );
    await keepExtending(c);
    return { changes: { set: { series: rows, ...(set.length ? { appointments: set } : {}) }, ...(out.removed.length ? { del: { appointments: out.removed } } : {}) }, ...out };
  });
}

/**
 * Cancels a visit of a series and all later ones ("only this one" is an ordinary cancel of that
 * booking). The series ends the day before `from`; its visits from that day on that nobody has
 * started on (and that are not in the past) move to the cancelled step, so the record stays.
 * Answers { changes, cancelled: [ids] }.
 */
export function stopSeries(workspaceId, who, id, body) {
  return write(workspaceId, async (c, cfg) => {
    const q = asQ(c);
    const me = await linkOf(q, workspaceId, who);
    const s = await getSeries(q, cfg, id, me);
    const stages = cfg.data.apptStages;
    const to = firstOf(stages, "cancelled");
    if (!to) throw new HttpError(409, "The bookings board has no cancelled step.", { code: "no_steps" });
    const set = [];
    for (const v of await visitsOf(c, cfg, id, body.from)) {
      if (!follows(cfg, v) || theirs(me, v)) continue;
      set.push(await saveAppointment(c, cfg, v, { status: to.id, busy: false, history: [...v.history, entry(cfg, who, { type: "status", from: v.status, to: to.id, reason: body.reason || "" })] }));
    }
    const { rows } = await c.query(`UPDATE crm_series SET until = $3::date - 1, count = NULL WHERE workspace_id = $1 AND id = $2 RETURNING ${SERIES}`, [workspaceId, id, body.from]);
    return { changes: { set: { series: rows, ...(set.length ? { appointments: set } : {}) } }, cancelled: set.map((r) => r.id) };
  });
}

/* ───── The daily job ───── */

const JOB = "crm_series_extend";
// A series that still has days to come: no end, or an end past what has been booked.
const RUNNING = "(until IS NULL OR until > through)";

/** Makes sure the daily job is waiting. Called whenever a series is made or changed: no series, no job. */
const keepExtending = (c) =>
  c.query(`INSERT INTO jobs (kind, payload, run_at) SELECT $1, '{}'::jsonb, now() + interval '1 day' WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE kind = $1 AND status = 'queued')`, [JOB]);

/**
 * Books the days that came into view for every running series, workspace by workspace, each
 * under that workspace's write lock. Returns how many bookings were made.
 */
export async function extendAll() {
  let made = 0;
  const { rows } = await query(`SELECT DISTINCT workspace_id FROM crm_series WHERE ${RUNNING}`);
  for (const { workspace_id: workspaceId } of rows) {
    // One workspace that fails (its data, a bug) must not keep the others' visits from being booked.
    const done = await write(workspaceId, async (c, cfg) => {
      let n = 0;
      const list = (await c.query(`SELECT ${SERIES}, created_by FROM crm_series WHERE workspace_id = $1 AND ${RUNNING} AND through < $2::date ORDER BY created_at, id`, [workspaceId, horizonOf(cfg)])).rows;
      for (const { created_by: createdBy, ...s } of list) {
        const r = await extend(c, cfg, s, createdBy);
        n += r.created.length;
        // A series that ran out of its count has nothing more to book: close it, so it stops coming up.
        if (s.count && seriesEnded(r.series, r.series.through)) {
          await c.query("UPDATE crm_series SET until = through WHERE workspace_id = $1 AND id = $2", [workspaceId, s.id]);
        }
      }
      return { made: n };
    }).catch((e) => console.error(`Repeat bookings of workspace ${workspaceId} were not extended:`, e.message));
    made += done?.made || 0;
  }
  return made;
}

registerJob(JOB, async () => {
  await extendAll();
  // Tomorrow again, while any series is still running.
  await query(
    `INSERT INTO jobs (kind, payload, run_at) SELECT $1, '{}'::jsonb, now() + interval '1 day'
      WHERE EXISTS (SELECT 1 FROM crm_series WHERE ${RUNNING}) AND NOT EXISTS (SELECT 1 FROM jobs WHERE kind = $1 AND status = 'queued')`,
    [JOB]
  );
});
