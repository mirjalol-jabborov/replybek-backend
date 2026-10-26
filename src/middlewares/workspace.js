import { query } from "../db.js";
import { notFound, forbidden, HttpError } from "../lib/http.js";
import { billingAccess } from "../services/workspaces.service.js";

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

// What a workspace can still change while it's read-only: paying, finishing onboarding, testing in the
// Playground (capped at PREVIEW_MESSAGES answers) and answering people already waiting in the inbox.
const OPEN_WHILE_LOCKED = [/^\/plan$/, /^\/billing\//, /^\/onboarding\//, /^\/agents\/[^/]+\/test$/, /^\/conversations\/[^/]+\/[\w-]+$/];

/**
 * Before the free trial starts (or once the subscription has ended) the workspace is read-only:
 * everything can be viewed, nothing added or changed. Onboarding is the exception, since it builds
 * the first agent before the trial; the dashboard keeps such workspaces in onboarding until it's done.
 */
export function readOnlyUntilTrial(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const access = billingAccess(req.workspace);
  if (access !== "none" && access !== "ended") return next();
  if (!req.workspace.settings?.onboarded) return next();
  if (OPEN_WHILE_LOCKED.some((re) => re.test(req.path))) return next();
  next(new HttpError(402, access === "ended" ? "Your subscription has ended. Choose a plan to make changes." : "Start your 7-day free trial to make changes.", { code: access === "ended" ? "subscription_ended" : "trial_required", reason: "read_only" }));
}
