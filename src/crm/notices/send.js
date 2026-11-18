// Sending the messages that are due, in the jobs worker (src/core/jobs.js). One job kind looks
// after every workspace: it sends what is due and queues itself for the next message's time.
//
// No message goes twice. A worker claims due rows in one UPDATE (queued → sending) over rows it
// locked with SKIP LOCKED, so two workers never claim the same row; only the worker that claimed
// a row sends it. A row left in `sending` by a worker that crashed mid-send is marked failed
// (`interrupted`), never sent again by itself: nobody knows whether it went out.
import { query } from "../../core/db.js";
import { registerJob } from "../../core/jobs.js";
import { send } from "../../core/senders.js";
import { withDefaults } from "../defaults.js";
import { noticeSettings } from "../shared/notices.js";
import { staleReason } from "./decide.js";

const JOB = "crm_notices_send";
const BATCH = 20;
/** Tries before a message is marked failed, and the wait (seconds) after each failed one. */
export const MAX_TRIES = 4;
export const BACKOFF = [60, 300, 1800];

/** Makes sure the sender runs at `at` (or sooner, if it is already set for sooner). */
export async function wake(at) {
  await query(
    `WITH sooner AS (UPDATE jobs SET run_at = LEAST(run_at, $2) WHERE kind = $1 AND status = 'queued' RETURNING id)
     INSERT INTO jobs (kind, payload, run_at) SELECT $1, '{}'::jsonb, $2 WHERE NOT EXISTS (SELECT 1 FROM sooner)`,
    [JOB, at]
  );
}

/**
 * Claims up to `limit` due messages for this worker alone. The rows are picked and locked once, in
 * a CTE (always run exactly once): as `id IN (subquery)` the planner may run the subquery again for
 * each row it updates, and a row locked by one run but not returned by the next stays queued and
 * locked, so other workers skip it and it is left out of every claim.
 */
export async function claimDue(limit = BATCH) {
  const { rows } = await query(
    `WITH due AS (SELECT id FROM crm_notices WHERE status = 'queued' AND send_at <= now() ORDER BY send_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
     UPDATE crm_notices n SET status = 'sending', claimed_at = now(), tries = n.tries + 1
       FROM due WHERE n.id = due.id AND n.status = 'queued'
      RETURNING n.id, n.workspace_id, n.kind, n.item_key, n.item_id, n.channel, n.address, n.text, n.tries, n.item_start, n.item_state, n.item_at <= now() AS late`,
    [limit]
  );
  return rows;
}

/**
 * Why a claimed message must not go after all, or null. The switches are read again (a business
 * may have turned one off since), and every message is checked against its item as the last write
 * left it (crm_notice_items): a message written for a visit or an order that changed since is
 * out of date, also when the newer news was switched off or its report never arrived. A reminder
 * must also find its booking still confirmed, at the time it names, not started yet.
 */
async function reasonsNotToSend(claimed) {
  const workspaces = [...new Set(claimed.map((n) => n.workspace_id))];
  const { rows: settings } = await query("SELECT workspace_id, data FROM crm_settings WHERE workspace_id = ANY($1::uuid[])", [workspaces]);
  const switches = Object.fromEntries(settings.map((s) => [s.workspace_id, noticeSettings(withDefaults(s.data).settings)]));
  const { rows: items } = await query(
    `SELECT i.workspace_id, i.item_id, i.state FROM crm_notice_items i
       JOIN unnest($1::uuid[], $2::text[], $3::uuid[]) AS r(w, k, id) ON i.workspace_id = r.w AND i.item_key = r.k AND i.item_id = r.id`,
    [claimed.map((n) => n.workspace_id), claimed.map((n) => n.item_key), claimed.map((n) => n.item_id)]
  );
  const stateOf = new Map(items.map((i) => [`${i.workspace_id}:${i.item_id}`, i.state]));
  const why = new Map();
  for (const n of claimed) {
    let reason = null;
    if (!switches[n.workspace_id]?.[n.kind]?.on) reason = "switched_off";
    else if (n.channel === "none") reason = "no_channel";
    else {
      const state = stateOf.get(`${n.workspace_id}:${n.item_id}`) || null;
      if (n.kind === "reminder") {
        if (n.late) reason = "too_late";
        else if (!state) reason = "item_gone";
        else if (state.kind !== "booked") reason = "item_closed";
        else if (state.start !== n.item_start) reason = "item_changed";
      }
      reason ||= staleReason(n.item_state, state);
    }
    if (reason) why.set(n.id, reason);
  }
  return why;
}

/** Writes down how a try went: sent, back in the queue for a later try, or failed for good. */
async function record(n, result) {
  if (result.ok) return query("UPDATE crm_notices SET status = 'sent', sent_at = now(), reason = NULL WHERE id = $1 AND status = 'sending'", [n.id]);
  if (result.retry && n.tries < MAX_TRIES) {
    const wait = BACKOFF[Math.min(n.tries, BACKOFF.length) - 1];
    return query("UPDATE crm_notices SET status = 'queued', reason = $2, send_at = now() + make_interval(secs => $3) WHERE id = $1 AND status = 'sending'", [n.id, result.code, wait]);
  }
  return query("UPDATE crm_notices SET status = 'failed', reason = $2 WHERE id = $1 AND status = 'sending'", [n.id, result.code]);
}

/**
 * Sends everything that is due, batch by batch, then queues the job for the next message.
 * Returns how many were sent, put back for another try, failed and skipped.
 */
export async function sendDue({ heartbeat } = {}) {
  const done = { sent: 0, retry: 0, failed: 0, skipped: 0 };
  // A worker that died mid-send: the message may or may not have gone, so it is not sent again by itself.
  await query("UPDATE crm_notices SET status = 'failed', reason = 'interrupted' WHERE status = 'sending' AND claimed_at < now() - interval '10 minutes'");
  for (let batch = await claimDue(); batch.length; batch = await claimDue()) {
    const why = await reasonsNotToSend(batch);
    const skipped = batch.filter((n) => why.has(n.id));
    if (skipped.length) {
      // A skipped message was never tried: its claim doesn't count as a try.
      await query(
        `UPDATE crm_notices n SET status = 'skipped', reason = r.reason, tries = n.tries - 1
           FROM unnest($1::uuid[], $2::text[]) AS r(id, reason) WHERE n.id = r.id AND n.status = 'sending'`,
        [skipped.map((n) => n.id), skipped.map((n) => why.get(n.id))]
      );
      done.skipped += skipped.length;
    }
    for (const n of batch.filter((x) => !why.has(x.id))) {
      const result = await send(n.channel, n.address, n.text);
      await record(n, result);
      done[result.ok ? "sent" : result.retry && n.tries < MAX_TRIES ? "retry" : "failed"]++;
      await heartbeat?.();
    }
  }
  const next = (await query("SELECT min(send_at) AS at FROM crm_notices WHERE status = 'queued'")).rows[0].at;
  if (next) await wake(next);
  return done;
}

registerJob(JOB, (payload, { heartbeat }) => sendDue({ heartbeat }));
