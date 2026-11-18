// Where a workspace's subscription stands, from what Polar last told us: paying, on trial, past due
// and for how long, ended. The AI agent's lock, the CRM's and the workspace summary all read it.
import { polarEnabled } from "./polar.js";

// Polar subscription statuses that still mean "paying customer". The rest (canceled, unpaid, incomplete…) don't.
// A subscription cancelled at period end stays "active" until it ends.
const PAID = new Set(["active", "trialing", "past_due"]);
export const isPaid = (status) => PAID.has(status);

// A failed renewal (past_due) keeps the workspace working this long while Polar retries the card.
export const OVERDUE_GRACE_DAYS = 3;

/** When a past_due workspace stops working, or null if it isn't past_due. */
export function graceEndsAt(workspace) {
  if (workspace.subscription_status !== "past_due" || !workspace.past_due_since) return null;
  return new Date(new Date(workspace.past_due_since).getTime() + OVERDUE_GRACE_DAYS * 86400000);
}

/** Past due for longer than the grace period: treated as ended until the card is updated. */
export const overdue = (workspace) => Boolean(graceEndsAt(workspace) && graceEndsAt(workspace) <= new Date());

/**
 * "trial" (Polar's free trial, card on file), "paid", "none" (no trial started yet) or "ended"
 * (cancelled, or past due beyond the grace period); null while billing is off (no Polar token),
 * when everything is allowed.
 */
export function billingAccess(workspace) {
  if (!polarEnabled()) return null;
  if (workspace.subscription_status === "trialing") return "trial";
  if (overdue(workspace)) return "ended";
  if (isPaid(workspace.subscription_status)) return "paid";
  return workspace.polar_subscription_id ? "ended" : "none";
}
