// How the CRM reads and writes its tables. Three rules keep it simple:
// 1. A CRM workspace's rows (settings, the default branch) are made the first time it is used.
// 2. Every write runs in write(): one transaction that first locks the workspace's settings row.
//    So writes in one workspace happen one after another, and a rule checked inside the
//    transaction (a free time, stock on hand, a phone number nobody has) still holds when it commits.
// 3. Every query filters by workspace_id.
// Readers take q(text, params), so the same reader works in read()'s picture and inside a write.
import { tx, getClient } from "../core/db.js";
import { defaults, withDefaults } from "./defaults.js";
import { afterWrite } from "./modules.js";

/**
 * SQL for a stored instant as the business's wall clock: "2026-11-17T09:30".
 * `tz`: where the time zone comes from, a parameter ("$2") or a column.
 */
export const wall = (column, tz) => `to_char(${column} AT TIME ZONE ${tz}, 'YYYY-MM-DD"T"HH24:MI')`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Whether a path parameter can be a row's id. Anything else reads as "not found" without asking the database. */
export const isUuid = (id) => typeof id === "string" && UUID.test(id);

/** A client inside a transaction as the plain q(text, params) the readers take. */
export const asQ = (c) => (text, params) => c.query(text, params);

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
async function ensureCrm(q, workspaceId) {
  await q("INSERT INTO crm_settings (workspace_id, data) VALUES ($1, $2) ON CONFLICT (workspace_id) DO NOTHING", [workspaceId, JSON.stringify(defaults())]);
  await q("INSERT INTO crm_branches (workspace_id, is_default) VALUES ($1, true) ON CONFLICT DO NOTHING", [workspaceId]);
}

/**
 * Runs one CRM write: fn(c, cfg, q) inside a transaction that holds the workspace's lock.
 * `c` is the transaction's client and `q` the same as q(text, params); `cfg` is the workspace's
 * CRM (see shape above), read under the lock. Whatever fn returns goes back with the new `rev`
 * added; if it throws, nothing is saved. Once it is saved, the modules hear of its changes
 * (afterWrite in modules.js): this is the one place every write of the CRM is reported from.
 *
 * `at` is the workspace's id, or a write that is already open ({ c, cfg }, as fn got them): then
 * fn runs inside it, as one more step of the caller's transaction (a public page or the AI agent
 * adds its own rows around a module's write). The caller's write bumps `rev` and reports the
 * changes it returns, so it passes on what fn returned.
 */
export async function write(at, fn) {
  if (typeof at === "object") return fn(at.c, at.cfg, asQ(at.c));
  const workspaceId = at;
  let cfg;
  const out = await tx(async (c) => {
    const q = asQ(c);
    const bump = `UPDATE crm_settings s SET rev = s.rev + 1 WHERE s.workspace_id = $1 RETURNING ${ROW}`;
    let { rows } = await q(bump, [workspaceId]);
    if (!rows[0]) {
      await ensureCrm(q, workspaceId);
      ({ rows } = await q(bump, [workspaceId]));
    }
    cfg = shape(workspaceId, rows[0]);
    return { ...(await fn(c, cfg, q)), rev: cfg.rev };
  });
  if (out.changes) await afterWrite({ workspaceId, cfg }, out.changes);
  return out;
}

/**
 * Runs fn(q, cfg) on one unchanging picture of the database, so rows read by several queries (the
 * snapshot's parts) belong together even while someone else is writing. `cfg` as write() gives it.
 */
export async function read(workspaceId, fn) {
  const c = await getClient();
  const q = asQ(c);
  const begin = async () => {
    await q("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return (await q(`SELECT ${ROW} FROM crm_settings s WHERE s.workspace_id = $1`, [workspaceId])).rows[0];
  };
  try {
    let row = await begin();
    if (!row) {
      // The first look at a new CRM: its rows are made outside the read-only picture.
      await q("ROLLBACK");
      await ensureCrm(q, workspaceId);
      row = await begin();
    }
    return await fn(q, shape(workspaceId, row));
  } finally {
    await q("ROLLBACK").catch(() => {});
    c.release();
  }
}

/* ───── Partial writes ───── */

/**
 * How an entity's fields are stored: `columns` maps a field to its column where the names differ,
 * `json` lists the fields kept as JSONB, `touch` says the table keeps updated_at.
 */
function stored(map, v) {
  const keys = Object.keys(v);
  return { cols: keys.map((k) => map.columns?.[k] || k), values: keys.map((k) => (map.json?.includes(k) ? JSON.stringify(v[k]) : v[k])) };
}
/** `ret` as SQL: a column list, or a function of the parameter holding the workspace's time zone. */
function returning(ret, cfg, params) {
  if (typeof ret !== "function") return ret;
  params.push(cfg.timezone);
  return ret(`$${params.length}`);
}

/** INSERT of the fields in `v` (plus the `base` columns) into a row of the workspace; resolves to the new rows as `ret` reads them. */
export async function insertRow(c, cfg, table, map, ret, v, base = {}) {
  const { cols, values } = stored(map, v);
  const all = ["workspace_id", ...Object.keys(base), ...cols];
  const params = [cfg.workspaceId, ...Object.values(base), ...values];
  const placeholders = all.map((_, i) => `$${i + 1}`).join(", ");
  return (await c.query(`INSERT INTO ${table} (${all.join(", ")}) VALUES (${placeholders}) RETURNING ${returning(ret, cfg, params)}`, params)).rows;
}

/** UPDATE of the fields in `v` on one row of the workspace; resolves to the rows as `ret` reads them. */
export async function updateRow(c, cfg, table, map, ret, id, v) {
  const { cols, values } = stored(map, v);
  const set = [...cols.map((k, i) => `${k} = $${i + 3}`), ...(map.touch ? ["updated_at = now()"] : [])];
  const params = [cfg.workspaceId, id, ...values];
  return (await c.query(`UPDATE ${table} SET ${set.join(", ")} WHERE workspace_id = $1 AND id = $2 RETURNING ${returning(ret, cfg, params)}`, params)).rows;
}
