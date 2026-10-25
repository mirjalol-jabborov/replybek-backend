import { query } from "../db.js";

/**
 * A small job queue in Postgres. Jobs are claimed with FOR UPDATE SKIP LOCKED, so several
 * workers can run safely; a job stuck "running" for 10 minutes (crashed worker) is retried.
 */
const handlers = {};
export const registerJob = (kind, fn) => (handlers[kind] = fn);
const MAX_ATTEMPTS = 3;

export const enqueue = (kind, payload, db = { query }) => db.query("INSERT INTO jobs (kind, payload) VALUES ($1, $2)", [kind, payload]);

/** Runs at most one ready job. Returns true if one ran. */
export async function runOne() {
  const { rows } = await query(
    `UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
      WHERE id = (
        SELECT id FROM jobs
         WHERE (status = 'queued' AND run_at <= now()) OR (status = 'running' AND locked_at < now() - interval '10 minutes')
         ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`
  );
  const job = rows[0];
  if (!job) return false;
  try {
    const handler = handlers[job.kind];
    if (!handler) throw new Error(`No handler for job kind "${job.kind}"`);
    // Long jobs (big websites) call heartbeat() so they aren't mistaken for a crashed worker.
    let beat = 0;
    const heartbeat = async () => {
      if (Date.now() - beat < 30000) return;
      beat = Date.now();
      await query("UPDATE jobs SET locked_at = now() WHERE id = $1", [job.id]);
    };
    await handler(job.payload, { attempt: job.attempts, final: job.attempts >= MAX_ATTEMPTS, heartbeat });
    await query("UPDATE jobs SET status = 'done', locked_at = NULL WHERE id = $1", [job.id]);
  } catch (e) {
    const failed = job.attempts >= MAX_ATTEMPTS;
    await query(
      `UPDATE jobs SET status = $2, locked_at = NULL, last_error = $3,
              run_at = now() + make_interval(secs => $4) WHERE id = $1`,
      [job.id, failed ? "failed" : "queued", String(e.message).slice(0, 1000), 10 * job.attempts ** 2]
    );
    if (failed) console.error(`Job ${job.id} (${job.kind}) failed:`, e.message);
  }
  return true;
}

/** Runs ready jobs until none are left (tests and scripts). */
export async function drainJobs(limit = 100) {
  let n = 0;
  while (n < limit && (await runOne())) n++;
  return n;
}

/** Queues a re-sync for website sources whose next_sync_at has passed. Returns how many. */
export async function enqueueDueSyncs() {
  const { rows } = await query(
    `UPDATE sources SET syncing = true WHERE id IN (
        SELECT id FROM sources WHERE type = 'website' AND next_sync_at <= now() AND status = 'ready' AND NOT syncing
         ORDER BY next_sync_at LIMIT 20 FOR UPDATE SKIP LOCKED)
      RETURNING id`
  );
  for (const r of rows) await enqueue("ingest_source", { source_id: r.id });
  return rows.length;
}

/** Polls for jobs forever (and checks for due re-syncs every minute). Returns a stop function. */
export function startWorker({ intervalMs = 1000 } = {}) {
  let stopped = false;
  let lastSyncCheck = 0;
  (async function loop() {
    while (!stopped) {
      if (Date.now() - lastSyncCheck > 60000) {
        lastSyncCheck = Date.now();
        await enqueueDueSyncs().catch((e) => console.error("Re-sync check failed:", e.message));
      }
      try {
        if (!(await runOne())) await new Promise((r) => setTimeout(r, intervalMs));
      } catch (e) {
        console.error("Worker error:", e.message);
        await new Promise((r) => setTimeout(r, intervalMs * 5));
      }
    }
  })();
  return () => (stopped = true);
}
