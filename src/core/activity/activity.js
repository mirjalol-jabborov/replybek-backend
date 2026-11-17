import { query } from "../db.js";

const fill = (key, params) => key.replace(/\{(\w+)\}/g, (m, k) => (params[k] ?? m));

/**
 * Records a line in the workspace's activity feed. `key` is an English template ("{actor} uploaded “{name}”")
 * that the dashboard translates; `detail` is either user content or `{ key }` for fixed text like "Draft".
 */
export const logActivity = (workspaceId, actorId, key, params = {}, detail = null) =>
  query("INSERT INTO activity (workspace_id, actor_id, text, key, params, detail, detail_key) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
    workspaceId,
    actorId,
    fill(key, params),
    key,
    params,
    typeof detail === "string" ? detail : detail?.key || null,
    detail?.key || null,
  ]);

export async function listActivity(workspaceId, limit = 20) {
  const { rows } = await query("SELECT id, text, key, params, detail, detail_key, created_at FROM activity WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT $2", [workspaceId, limit]);
  return rows;
}

const period = () => new Date().toISOString().slice(0, 7);

/** Counts one AI reply toward the workspace's monthly message allowance. */
export const countMessage = (workspaceId, n = 1) =>
  query(
    `INSERT INTO usage (workspace_id, period, messages) VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, period) DO UPDATE SET messages = usage.messages + EXCLUDED.messages`,
    [workspaceId, period(), n]
  );

export async function messagesUsed(workspaceId) {
  const { rows } = await query("SELECT messages FROM usage WHERE workspace_id = $1 AND period = $2", [workspaceId, period()]);
  return rows[0]?.messages || 0;
}
