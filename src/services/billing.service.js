import { query } from "../db.js";
import { HttpError } from "../lib/http.js";
import { polarProductId, planForPolarProduct, createCheckout, changeProduct, cancelAtPeriodEnd, portalUrl } from "../lib/polar.js";
import { logActivity } from "./activity.service.js";
import { assertPlanFits, isPaid } from "./workspaces.service.js";

const TRIAL_DAYS = 7;
const appOrigin = () => process.env.APP_ORIGIN || "http://localhost:5173";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Moves the workspace to `plan`. A running subscription (trial included) switches product in place and
 * returns { changed: true }. Otherwise it's a Polar checkout ({ url }), and the plan changes when Polar's
 * webhook confirms it. Only a workspace that never had a subscription gets the free trial.
 */
export async function startCheckout(workspace, plan, user, returnTo = "billing") {
  const productId = polarProductId(plan);
  if (!productId) throw new HttpError(503, `The ${plan} plan isn't set up for payment yet.`);
  const running = workspace.polar_subscription_id && isPaid(workspace.subscription_status);
  if (workspace.plan === plan && running) throw new HttpError(409, `You're already on the ${plan} plan.`);
  await assertPlanFits(workspace, plan);

  if (running) {
    let subscription;
    try {
      subscription = await changeProduct(workspace.polar_subscription_id, productId);
    } catch (e) {
      console.error(e.message);
      throw new HttpError(502, "Polar isn't reachable right now. Try again in a minute.");
    }
    await applySubscription(subscription, { actor: user, workspaceId: workspace.id });
    return { changed: true };
  }

  const back = returnTo === "onboarding" ? "onboarding" : "settings/billing";
  let checkout;
  try {
    checkout = await createCheckout({
      productId,
      externalCustomerId: workspace.id,
      email: user.email,
      metadata: { workspace_id: workspace.id, plan },
      successUrl: `${appOrigin()}/?checkout=done#/${back}`,
      returnUrl: `${appOrigin()}/#/${back}`,
      trialDays: workspace.polar_subscription_id ? 0 : TRIAL_DAYS,
    });
  } catch (e) {
    console.error(e.message);
    throw new HttpError(502, "Polar checkout isn't reachable right now. Try again in a minute.");
  }
  await query("INSERT INTO billing_checkouts (id, workspace_id, plan, user_id) VALUES ($1, $2, $3, $4)", [checkout.id, workspace.id, plan, user.id]);
  return { url: checkout.url };
}

/** A signed-in link to Polar's customer portal: card, invoices, cancellation. */
export async function billingPortal(workspace) {
  if (!workspace.polar_subscription_id) throw new HttpError(404, "There's no subscription to manage yet.");
  try {
    return { url: await portalUrl(workspace.id, `${appOrigin()}/#/settings/billing`) };
  } catch (e) {
    console.error(e.message);
    throw new HttpError(502, "Polar isn't reachable right now. Try again in a minute.");
  }
}

/**
 * Applies one verified Polar event. Polar delivers at least once and in any order, so each webhook-id
 * is applied once, and only the workspace's current subscription can change its status.
 */
export async function handlePolarEvent(eventId, event) {
  const seen = await query("SELECT 1 FROM billing_events WHERE id = $1", [eventId]);
  if (seen.rowCount) return { duplicate: true };
  if (String(event.type || "").startsWith("subscription.")) await applySubscription(event.data || {});
  await query("INSERT INTO billing_events (id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING", [eventId, event.type || "unknown"]);
  return { ok: true };
}

/**
 * Stores a subscription's state on its workspace. A new subscription that is paying (or trialing) becomes
 * the workspace's current one, and the one it replaces stops renewing; any other subscription is ignored.
 */
async function applySubscription(s, { actor = null, workspaceId: known = null } = {}) {
  const checkout = s.checkout_id
    ? (await query("SELECT c.workspace_id, u.id AS user_id, u.name FROM billing_checkouts c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = $1", [s.checkout_id])).rows[0]
    : null;
  const workspaceId = known || checkout?.workspace_id || [s.metadata?.workspace_id, s.customer?.external_id].find((id) => UUID.test(id || "")) || null;
  const plan = planForPolarProduct(s.product_id);
  if (!workspaceId || !plan) return console.warn(`Polar subscription ${s.id}: no matching workspace or plan (product ${s.product_id}).`);
  const { rows } = await query("SELECT plan, polar_subscription_id, subscription_status FROM workspaces WHERE id = $1", [workspaceId]);
  if (!rows[0]) return console.warn(`Polar subscription ${s.id}: workspace ${workspaceId} no longer exists.`);
  const ws = rows[0];
  const current = ws.polar_subscription_id === s.id;
  if (!current && !isPaid(s.status)) return;

  const renewsAt = (s.status === "trialing" && s.trial_end) || s.current_period_end || null;
  await query(
    `UPDATE workspaces SET plan = $2, polar_subscription_id = $3, subscription_status = $4, renews_at = $5, cancel_at_period_end = $6 WHERE id = $1`,
    [workspaceId, plan, s.id, s.status, renewsAt, Boolean(s.cancel_at_period_end)]
  );
  if (!current || ws.plan !== plan) {
    const who = actor || (checkout?.user_id ? { id: checkout.user_id, name: checkout.name } : null);
    if (who) await logActivity(workspaceId, who.id, "{actor} switched to the {plan} plan", { actor: who.name, plan }, { key: "Paid through Polar" });
    else await logActivity(workspaceId, null, "Subscribed to the {plan} plan", { plan }, { key: "Paid through Polar" });
  }
  // A second subscription replaced the running one; stop the old one renewing. Not awaited: Polar wants a quick reply.
  if (!current && ws.polar_subscription_id && isPaid(ws.subscription_status)) {
    const old = ws.polar_subscription_id;
    cancelAtPeriodEnd(old).catch((e) => console.error(`Couldn't cancel old Polar subscription ${old}: ${e.message}`));
  }
}
