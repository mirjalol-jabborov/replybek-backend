// What the other areas ask about branches: which branch a write goes to, which rows a person
// may see, and what the booking rules need to know of each place. Booking and Store import this
// file (not index.js, which imports Store for moving goods), so nothing here imports a module.
//
// A team member limited to one branch (crm_member_branches, role `agent`) sees and changes only
// that branch: `req.branchOnly` is their branch, set once per request by `scope`, and the areas
// pass it down as `who.branchOnly` (Booking) or `user.branchOnly` (Store).
import { query } from "../../core/db.js";
import { HttpError, wrap } from "../../core/http.js";
import { isUuid } from "../db.js";
import { bad, conflict } from "../errors.js";

/** The branch a team member is limited to, or null. Only a team member (`agent`) is ever limited. */
export async function limitOf(workspaceId, user, role) {
  if (role !== "agent") return null;
  const { rows } = await query("SELECT branch_id FROM crm_member_branches WHERE workspace_id = $1 AND user_id = $2", [workspaceId, user.id]);
  return rows[0]?.branch_id || null;
}

/** Sets req.branchOnly for every CRM route: the signed-in person's branch when they are limited to one, else null. */
export const scope = wrap(async (req, res, next) => {
  req.branchOnly = await limitOf(req.workspace.id, req.user, req.role);
  next();
});

const otherBranch = () => new HttpError(403, "You work at another branch.", { code: "other_branch" });

/**
 * The branch a write goes to: the one sent, else the person's own (when limited), else the
 * default. A branch of another workspace, or none at all, is 400 bad_branch; a limited person
 * naming another is 403 other_branch; `work` (new work: a booking, an order, goods coming in)
 * refuses a closed branch, 409 branch_closed. `who` is the team's { branchOnly } or a customer
 * (never limited). The default branch can't be closed, so it is answered without a query.
 */
export async function needBranch(q, cfg, who, sent, { work = false } = {}) {
  const only = who?.branchOnly || null;
  const id = sent || only || cfg.branchId;
  if (only && id !== only) throw otherBranch();
  if (id === cfg.branchId) return id;
  const branch = isUuid(id) && (await q("SELECT active FROM crm_branches WHERE workspace_id = $1 AND id = $2", [cfg.workspaceId, id])).rows[0];
  if (!branch) throw bad("This branch doesn't exist.", "bad_branch");
  if (work && !branch.active) throw conflict("This branch is closed.", "branch_closed", { branchId: id });
  return id;
}

/** A team member limited to a branch may not touch a row of another: 403 other_branch. */
export function ownBranch(who, branchId) {
  if (who?.branchOnly && branchId !== who.branchOnly) throw otherBranch();
}

/**
 * The branch a read is narrowed to: `asked` (?branch=), else the person's own, else null (all).
 * Asking for another workspace's branch is 400 bad_branch; a limited person asking for another 403.
 */
export async function narrowTo(q, cfg, asked, only) {
  if (asked === undefined) return only || null;
  if (typeof asked !== "string" || !isUuid(asked) || !(await q("SELECT 1 FROM crm_branches WHERE workspace_id = $1 AND id = $2", [cfg.workspaceId, asked])).rows[0]) {
    throw bad("This branch doesn't exist.", "bad_branch");
  }
  if (only && asked !== only) throw otherBranch();
  return asked;
}

/** What the booking rules read of each place: [{ id, hours, active }] (see shared/branches.js). */
export async function branchRules(q, cfg) {
  return (await q("SELECT id, hours, active FROM crm_branches WHERE workspace_id = $1 ORDER BY id", [cfg.workspaceId])).rows;
}
