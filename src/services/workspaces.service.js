import { query } from "../db.js";
import { messagesUsed, logActivity } from "./activity.service.js";
import { HttpError } from "../lib/http.js";
import { polarEnabled } from "../lib/polar.js";

// `pages`: the most pages one website source imports.
export const PLANS = {
  starter: { messages: 2000, agents: 1, seats: 2, sources: 10, pages: 50 },
  growth: { messages: 10000, agents: 5, seats: 5, sources: 50, pages: 500 },
  business: { messages: 50000, agents: 20, seats: 15, sources: 250, pages: 5000 },
};

// Polar subscription statuses that still mean "paying customer". The rest (canceled, unpaid, incomplete…) don't.
// A subscription cancelled at period end stays "active" until it ends.
const PAID = new Set(["active", "trialing", "past_due"]);
export const isPaid = (status) => PAID.has(status);

/**
 * "trial" (Polar's free trial, card on file), "paid", "none" (no trial started yet) or "ended";
 * null while billing is off (no Polar token), when everything is allowed.
 */
export function billingAccess(workspace) {
  if (!polarEnabled()) return null;
  if (workspace.subscription_status === "trialing") return "trial";
  if (isPaid(workspace.subscription_status)) return "paid";
  return workspace.polar_subscription_id ? "ended" : "none";
}

// Before the trial starts, the owner can still try their agent in the Playground (and onboarding):
// a few answers, enough to see it work. AI costs money, so the rest waits for the card-backed trial.
export const PREVIEW_MESSAGES = 3;

/** The first day of next month (UTC), when the monthly message allowance starts over. */
export function allowanceResets(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/**
 * Agents answer with AI only while the workspace is in its trial or paid (the Playground gets a small
 * allowance before that), and only up to the plan's AI messages this month.
 */
export async function assertCanAnswer(workspaceId, { playground = false } = {}) {
  const { rows } = await query("SELECT plan, subscription_status, polar_subscription_id FROM workspaces WHERE id = $1", [workspaceId]);
  if (!rows[0]) return;
  const used = await messagesUsed(workspaceId);
  const access = billingAccess(rows[0]);
  if (access === "none" || access === "ended") {
    if (access === "none" && playground && used < PREVIEW_MESSAGES) return;
    throw new HttpError(
      402,
      access === "ended"
        ? "Your subscription has ended. Choose a plan to keep your agents answering."
        : playground
          ? `You've used your ${PREVIEW_MESSAGES} free test messages. Start your 7-day free trial to keep testing.`
          : "Start your 7-day free trial to put your agent live.",
      { code: access === "ended" ? "subscription_ended" : "trial_required", reason: playground ? "preview_used" : "not_live" }
    );
  }
  const limit = PLANS[rows[0].plan]?.messages;
  if (limit && used >= limit) {
    throw new HttpError(402, `You've used all ${limit} AI messages in your plan this month. Upgrade the plan to keep your agents answering.`, {
      code: "limit_messages",
      limit,
      resets_at: allowanceResets(),
    });
  }
}

/** Refuses one more agent or knowledge source than the workspace's plan includes. */
export async function assertRoomFor(workspaceId, kind) {
  const table = { agents: "agents", sources: "sources" }[kind];
  const { rows } = await query(`SELECT w.plan, (SELECT count(*)::int FROM ${table} WHERE workspace_id = w.id) AS n FROM workspaces w WHERE w.id = $1`, [workspaceId]);
  const limit = PLANS[rows[0]?.plan]?.[kind];
  if (limit == null || rows[0].n < limit) return;
  throw new HttpError(
    402,
    kind === "agents"
      ? `Your plan includes ${limit} ${limit === 1 ? "agent" : "agents"}. Upgrade the plan or delete an agent first.`
      : `Your plan includes ${limit} knowledge sources. Upgrade the plan or remove a source first.`,
    { code: `limit_${kind}`, limit }
  );
}

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
  const { polar_subscription_id, subscription_status, renews_at, cancel_at_period_end, ...rest } = workspace;
  const billing = {
    provider: polarEnabled() ? "polar" : null,
    access: billingAccess(workspace),
    preview_messages: PREVIEW_MESSAGES,
    status: subscription_status || null,
    renews_at: renews_at || null,
    cancel_at_period_end: Boolean(cancel_at_period_end),
    // The owner opens Polar's customer portal through POST /billing/portal.
    can_manage: role === "owner" && Boolean(polar_subscription_id),
  };
  return { ...rest, role, limits: PLANS[workspace.plan], usage: { messages: used, ...counts.rows[0] }, billing };
}

export async function updateWorkspace(id, input) {
  const { rows } = await query(
    // A real name replaces the provisional one a Google sign-up got.
    "UPDATE workspaces SET name = COALESCE($2, name), website = COALESCE($3, website), timezone = COALESCE($4, timezone), settings = CASE WHEN $2::text IS NULL THEN settings ELSE settings - 'auto_named' END WHERE id = $1 RETURNING *",
    [id, input.name ?? null, input.website ?? null, input.timezone ?? null]
  );
  return rows[0];
}

export async function listMembers(workspaceId) {
  const { rows } = await query(
    "SELECT u.id, u.name, u.email, u.avatar, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY m.created_at",
    [workspaceId]
  );
  return rows;
}

/** Refuses a plan the workspace's current usage doesn't fit. */
export async function assertPlanFits(workspace, plan) {
  const summary = await workspaceSummary(workspace, "owner");
  const limits = PLANS[plan];
  const over = ["messages", "agents", "seats", "sources"].filter((k) => summary.usage[k] > limits[k]);
  if (over.length) throw new HttpError(409, `Your current usage is above the ${plan} plan's limits (${over.join(", ")}).`);
}

/** Simulated plan change, used only while Polar isn't configured. With Polar, plans change through checkout. */
export async function changePlan(workspace, plan, user) {
  if (polarEnabled()) throw new HttpError(409, "Plans change through Polar checkout.");
  await assertPlanFits(workspace, plan);
  const { rows } = await query("UPDATE workspaces SET plan = $2 WHERE id = $1 RETURNING *", [workspace.id, plan]);
  await logActivity(workspace.id, user.id, "{actor} switched to the {plan} plan", { actor: user.name, plan }, { key: "Simulated, no payment" });
  return workspaceSummary(rows[0], "owner");
}
