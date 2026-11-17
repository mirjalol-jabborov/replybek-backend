// How the CRM reads and writes its tables. Three rules keep it simple:
// 1. A CRM workspace's rows (settings, the default branch) are made the first time it is used.
// 2. Every write runs in write(): one transaction that first locks the workspace's settings row.
//    So writes in one workspace happen one after another, and a rule checked inside the
//    transaction (a free time, stock on hand, a phone number nobody has) still holds when it commits.
// 3. Every query filters by workspace_id.
import { query, tx, getClient } from "../db.js";
import { defaults, withDefaults } from "./defaults.js";

/**
 * SQL for a stored instant as the business's wall clock: "2026-11-17T09:30".
 * `tz`: where the time zone comes from, a parameter ("$2") or a column.
 */
export const wall = (column, tz) => `to_char(${column} AT TIME ZONE ${tz}, 'YYYY-MM-DD"T"HH24:MI')`;

const ROW = `s.data, s.rev, s.timezone,
  (SELECT b.id FROM crm_branches b WHERE b.workspace_id = s.workspace_id AND b.is_default) AS branch_id,
  ${wall("now()", "s.timezone")} AS now`;

/**
 * A workspace's CRM as code reads it:
 * { workspaceId, data (the editable lists and settings), rev, timezone, branchId (the default
 *   branch), now ("2026-11-17T09:30" on the business's clock, the "now" every rule uses) }.
 */
const shape = (workspaceId, r) => ({ workspaceId, data: withDefaults(r.data), rev: Number(r.rev), timezone: r.timezone, branchId: r.branch_id, now: r.now });

/** Makes the CRM's rows for a workspace that has none yet. Safe to call twice at once. */
export async function ensureCrm(workspaceId, q = query) {
  await q("INSERT INTO crm_settings (workspace_id, data) VALUES ($1, $2) ON CONFLICT (workspace_id) DO NOTHING", [workspaceId, JSON.stringify(defaults())]);
  await q("INSERT INTO crm_branches (workspace_id, is_default) VALUES ($1, true) ON CONFLICT DO NOTHING", [workspaceId]);
}

/** Reads the workspace's CRM, making it first if this is its first use. `q`: a client inside a transaction, when there is one. */
export async function load(workspaceId, q = query) {
  const sql = `SELECT ${ROW} FROM crm_settings s WHERE s.workspace_id = $1`;
  let { rows } = await q(sql, [workspaceId]);
  if (!rows[0]) {
    await ensureCrm(workspaceId, q);
    ({ rows } = await q(sql, [workspaceId]));
  }
  return shape(workspaceId, rows[0]);
}

/**
 * Runs one CRM write: fn(c, cfg) inside a transaction that holds the workspace's lock.
 * `c` is the transaction's client (use c.query for everything), `cfg` is the workspace's CRM
 * as load() gives it, read under the lock. Whatever fn returns goes back with the new `rev` added;
 * if it throws, nothing is saved.
 */
export function write(workspaceId, fn) {
  return tx(async (c) => {
    const bump = `UPDATE crm_settings s SET rev = s.rev + 1 WHERE s.workspace_id = $1 RETURNING ${ROW}`;
    let { rows } = await c.query(bump, [workspaceId]);
    if (!rows[0]) {
      await ensureCrm(workspaceId, (text, params) => c.query(text, params));
      ({ rows } = await c.query(bump, [workspaceId]));
    }
    const cfg = shape(workspaceId, rows[0]);
    return { ...(await fn(c, cfg)), rev: cfg.rev };
  });
}

/**
 * Runs fn(q) on one unchanging picture of the database, so rows read by several queries (the
 * snapshot's parts) belong together even while someone else is writing.
 */
export async function read(fn) {
  const c = await getClient();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return await fn((text, params) => c.query(text, params));
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}
