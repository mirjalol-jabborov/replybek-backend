// The daily job of repeat bookings: every day, the days that came into view (rules.maxDays ahead)
// are booked for every running series, each day checked like any booking (see extend() in series.js).
import { query } from "../../core/db.js";
import { registerJob } from "../../core/jobs.js";
import { write } from "../db.js";
import { seriesEnded } from "../shared/booking.js";
import { SERIES, loadRules } from "./rows.js";
import { JOB, RUNNING, extend, horizonOf, firstToBook } from "./series.js";

/** The days after `through` that already have a visit, for each of these series: { [seriesId]: Set(days) }. */
async function bookedDays(q, cfg, list) {
  const out = Object.fromEntries(list.map((s) => [s.id, new Set()]));
  if (!list.length) return out;
  const { rows } = await q(
    `SELECT a.series_id AS id, to_char(a.series_day, 'YYYY-MM-DD') AS day FROM crm_appointments a
      JOIN unnest($2::uuid[], $3::date[]) AS s(id, through) ON s.id = a.series_id
     WHERE a.workspace_id = $1 AND a.series_day > s.through`,
    [cfg.workspaceId, list.map((s) => s.id), list.map((s) => s.through)]
  );
  for (const r of rows) out[r.id].add(r.day);
  return out;
}

// Series booked in one transaction. The calendar's own writes wait for the workspace's lock, so
// the job takes it for a few series at a time rather than for all of them.
const BATCH = 20;

/**
 * Books the days in view for a batch of the workspace's series that are behind, under the
 * workspace's write lock. The rules' data is read once for the batch; each booking made joins it,
 * so the next series sees it. Returns { made, more } (more: series are left for another batch).
 */
function extendBatch(workspaceId) {
  return write(workspaceId, async (c, cfg, q) => {
    const horizon = horizonOf(cfg);
    // One more than a batch, to know whether another one follows.
    const { rows } = await q(`SELECT ${SERIES}, created_by FROM crm_series WHERE workspace_id = $1 AND ${RUNNING} AND through < $2::date ORDER BY created_at, id LIMIT ${BATCH + 1}`, [workspaceId, horizon]);
    const list = rows.slice(0, BATCH);
    if (!list.length) return { made: 0, more: false };
    const from = list.reduce((d, s) => (firstToBook(cfg, s) < d ? firstToBook(cfg, s) : d), horizon);
    const db = await loadRules(q, cfg, from, horizon);
    const have = await bookedDays(q, cfg, list);
    let made = 0;
    for (const { created_by: createdBy, ...s } of list) {
      const r = await extend(c, cfg, s, createdBy, { db, have: have[s.id] });
      made += r.created.length;
      // A series that ran out of its count has nothing more to book: close it, so it stops coming up.
      if (s.count && seriesEnded(r.series, r.series.through)) {
        await q("UPDATE crm_series SET until = through WHERE workspace_id = $1 AND id = $2", [workspaceId, s.id]);
      }
    }
    // Each series of the batch is booked through the horizon now, so the next batch starts after them.
    return { made, more: rows.length > BATCH };
  });
}

/** Books the days that came into view for every running series, workspace by workspace. Returns how many bookings were made. */
export async function extendAll() {
  let made = 0;
  const { rows } = await query(`SELECT DISTINCT workspace_id FROM crm_series WHERE ${RUNNING}`);
  for (const { workspace_id: workspaceId } of rows) {
    // One workspace that fails (its data, a bug) must not keep the others' visits from being booked.
    try {
      for (let more = true; more; ) {
        const r = await extendBatch(workspaceId);
        made += r.made;
        more = r.more;
      }
    } catch (e) {
      console.error(`Repeat bookings of workspace ${workspaceId} were not extended:`, e.message);
    }
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
