import { query } from "../db.js";
import { messagesUsed, logActivity } from "./activity.service.js";
import { HttpError } from "../lib/http.js";

// `pages`: the most pages one website source imports.
export const PLANS = {
  starter: { messages: 2000, agents: 1, seats: 2, sources: 10, pages: 50 },
  growth: { messages: 10000, agents: 5, seats: 5, sources: 50, pages: 500 },
  business: { messages: 50000, agents: 20, seats: 15, sources: 250, pages: 5000 },
};

export async function workspaceSummary(workspace, role) {
  const [used, counts] = await Promise.all([
    messagesUsed(workspace.id),
    query(
      `SELECT (SELECT count(*)::int FROM agents WHERE workspace_id = $1) AS agents,
              (SELECT count(*)::int FROM memberships WHERE workspace_id = $1) AS seats,
              (SELECT count(*)::int FROM sources WHERE workspace_id = $1) AS sources,
              (SELECT count(*)::int FROM conversations WHERE workspace_id = $1 AND status = 'needs_human') AS waiting`,
      [workspace.id]
    ),
  ]);
  return { ...workspace, role, limits: PLANS[workspace.plan], usage: { messages: used, ...counts.rows[0] } };
}

export async function updateWorkspace(id, input) {
  const { rows } = await query(
    "UPDATE workspaces SET name = COALESCE($2, name), website = COALESCE($3, website), timezone = COALESCE($4, timezone) WHERE id = $1 RETURNING *",
    [id, input.name ?? null, input.website ?? null, input.timezone ?? null]
  );
  return rows[0];
}

export async function listMembers(workspaceId) {
  const { rows } = await query(
    "SELECT u.id, u.name, u.email, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY m.created_at",
    [workspaceId]
  );
  return rows;
}

/** Simulated plan change (no billing yet). Refuses plans the current usage doesn't fit. */
export async function changePlan(workspace, plan, user) {
  const summary = await workspaceSummary(workspace, "owner");
  const limits = PLANS[plan];
  const over = ["messages", "agents", "seats", "sources"].filter((k) => summary.usage[k] > limits[k]);
  if (over.length) throw new HttpError(409, `Your current usage is above the ${plan} plan's limits (${over.join(", ")}).`);
  const { rows } = await query("UPDATE workspaces SET plan = $2 WHERE id = $1 RETURNING *", [workspace.id, plan]);
  await logActivity(workspace.id, user.id, "{actor} switched to the {plan} plan", { actor: user.name, plan }, { key: "Simulated, no payment" });
  return workspaceSummary(rows[0], "owner");
}
