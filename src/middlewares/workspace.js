import { query } from "../db.js";
import { notFound, forbidden } from "../lib/http.js";

const RANK = { agent: 1, admin: 2, owner: 3 };

/**
 * For routes under /w/:wid. Checks the signed-in user belongs to the workspace and sets
 * req.workspace and req.role. Someone outside the workspace gets 404, so ids don't leak.
 */
export async function requireWorkspace(req, res, next) {
  try {
    const { wid } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(wid)) throw notFound("Workspace not found");
    const { rows } = await query(
      `SELECT w.*, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
        WHERE w.id = $1 AND m.user_id = $2`,
      [wid, req.user.id]
    );
    if (!rows[0]) throw notFound("Workspace not found");
    const { role, ...workspace } = rows[0];
    req.workspace = workspace;
    req.role = role;
    next();
  } catch (e) {
    next(e);
  }
}

/** Requires at least this role: agent < admin < owner. */
export const requireRole = (role) => (req, res, next) => (RANK[req.role] >= RANK[role] ? next() : next(forbidden("Only workspace admins can do this.")));
