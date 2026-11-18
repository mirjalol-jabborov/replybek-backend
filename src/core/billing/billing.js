import { query, tx } from "../db.js";
import { HttpError } from "../http.js";
import { appOrigins } from "../auth/session.js";
import { polarEnabled, createCheckout, changeProduct, cancelAtPeriodEnd, portalUrl, customerSubscriptions } from "./polar.js";
import { logActivity } from "../activity/activity.js";
import { assertPlanFits, isPaid, addProduct } from "../workspaces/workspaces.js";
import { billed, checkoutTrialDays, offerFor, offerForPolarProduct, packageOf, packageOfWorkspace, polarProductFor, productsAfter } from "./packages.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unreachable = () => new HttpError(502, "Polar isn't reachable right now. Try again in a minute.", { code: "billing_unreachable" });

/** The package a checkout without one means: the one that gives what the workspace has now. */
export const defaultPackage = (workspace) => packageOf(offerFor(workspace).package);

/**
 * Moves the workspace to one package and tier. A running subscription (trial included) switches
 * product in place and returns { changed: true }: one subscription per workspace, so adding the
 * other product is a change of package. Otherwise it's a Polar checkout ({ url }), and the package
 * changes when Polar's webhook confirms it. Each product's trial is given once per workspace.
 */
export async function startCheckout(workspace, { pkg, tier }, user, { returnTo = "billing", origin = null } = {}) {
  const free = pkg.products.find((p) => !billed(p));
  if (free) throw new HttpError(409, "This package isn't sold while its product is free.", { code: "product_free", product: free });
  if (!pkg.tiers.includes(tier)) throw new HttpError(400, "This package has no such tier.", { code: "bad_tier" });
  const productId = polarProductFor(pkg, tier);
  if (!productId) throw new HttpError(503, `The ${tier} plan isn't set up for payment yet.`, { code: "offer_not_ready", package: pkg.key, tier });
  const running = workspace.polar_subscription_id && isPaid(workspace.subscription_status);
  if (running && workspace.plan === tier && packageOfWorkspace(workspace) === pkg) throw new HttpError(409, `You're already on the ${tier} plan.`, { code: "already_on" });
  // The AI agent's limits (messages, agents, sources) count only for a package that gives it.
  if (pkg.products.includes("agent")) await assertPlanFits(workspace, tier);

  if (running) {
    let subscription;
    try {
      subscription = await changeProduct(workspace.polar_subscription_id, productId);
    } catch (e) {
      console.error(e.message);
      throw unreachable();
    }
    await applySubscription(subscription, { actor: user, workspaceId: workspace.id });
    return { changed: true };
  }

  const home = origin || appOrigins()[0];
  const back = home !== appOrigins()[0] ? "" : returnTo === "onboarding" ? "onboarding" : "settings/billing";
  let checkout;
  try {
    checkout = await createCheckout({
      productId,
      externalCustomerId: workspace.id,
      email: user.email,
      metadata: { workspace_id: workspace.id, plan: tier, package: pkg.key },
      successUrl: `${home}/?checkout=done#/${back}`,
      returnUrl: `${home}/#/${back}`,
      trialDays: checkoutTrialDays(workspace, pkg),
    });
  } catch (e) {
    console.error(e.message);
    throw new HttpError(502, "Polar checkout isn't reachable right now. Try again in a minute.", { code: "billing_unreachable" });
  }
  await query("INSERT INTO billing_checkouts (id, workspace_id, plan, package, user_id) VALUES ($1, $2, $3, $4, $5)", [checkout.id, workspace.id, tier, pkg.key, user.id]);
  return { url: checkout.url };
}

/**
 * POST /products. While the CRM is free, a product is added as it always was (the AI agent's own
 * lock still applies to it). Once the CRM is billed, it is bought: the package that gives what the
 * workspace has plus this product, through checkout or a change of the running subscription.
 */
export async function addProductOrBuy(workspace, product, user, options) {
  if (workspace.products.includes(product) || !billed("crm")) return addProduct(workspace, product);
  const offer = offerFor(workspace, product);
  const result = await startCheckout(workspace, { pkg: packageOf(offer.package), tier: offer.tier }, user, options);
  const { rows } = await query("SELECT products FROM workspaces WHERE id = $1", [workspace.id]);
  return { products: rows[0].products, ...result };
}

/**
 * Asks Polar what this workspace is actually subscribed to, and writes that down. Webhooks stay the
 * fast path, but one can be missed: a restart mid-delivery, an outage, a server not yet reachable
 * from the internet. Without this, someone who has paid stays locked out of their own workspace
 * with nothing they can do about it. Safe to call as often as you like.
 */
export async function syncSubscription(workspace, { actor = null } = {}) {
  if (!polarEnabled()) return { changed: false, status: null };
  let subscriptions;
  try {
    subscriptions = await customerSubscriptions(workspace.id);
  } catch (e) {
    console.error(e.message);
    throw unreachable();
  }
  // A live subscription is what matters; an ended one only to record that it ended.
  const live = subscriptions.find((s) => isPaid(s.status) && offerForPolarProduct(s.product_id));
  const subscription = live || subscriptions.find((s) => s.id === workspace.polar_subscription_id) || null;
  if (!subscription) return { changed: false, status: null };
  await applySubscription(subscription, { actor, workspaceId: workspace.id });
  const { rows } = await query("SELECT plan, billing_package, products, subscription_status FROM workspaces WHERE id = $1", [workspace.id]);
  const now = rows[0];
  const changed = now.subscription_status !== (workspace.subscription_status || null) || now.billing_package !== workspace.billing_package || now.products.join() !== workspace.products.join();
  return { changed, status: now.subscription_status || null, plan: now.plan, package: now.billing_package, products: now.products };
}

/** A signed-in link to Polar's customer portal: card, invoices, cancellation. */
export async function billingPortal(workspace) {
  if (!workspace.polar_subscription_id) throw new HttpError(404, "There's no subscription to manage yet.", { code: "no_subscription" });
  try {
    return { url: await portalUrl(workspace.id, `${appOrigins()[0]}/#/settings/billing`) };
  } catch (e) {
    console.error(e.message);
    throw unreachable();
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

// The workspace under a row lock, and how this picture of a subscription compares with what it holds:
// `stale` (an older picture of its current subscription), `older` (started before the current one;
// a current one stored before packages has no start yet and counts as the newest until its next event).
const LOCKED = `SELECT plan, products, billing_package, trial_products, polar_subscription_id, subscription_status,
       $2::timestamptz < subscription_modified_at AS stale, $3::timestamptz < COALESCE(subscription_created_at, 'infinity') AS older
  FROM workspaces WHERE id = $1 FOR UPDATE`;

const SAVE = `UPDATE workspaces SET plan = $2, billing_package = $3, products = $4, trial_products = $5, polar_subscription_id = $6,
       subscription_status = $7, renews_at = $8, cancel_at_period_end = $9,
       past_due_since = CASE WHEN $7 = 'past_due' THEN COALESCE(past_due_since, now()) END,
       subscription_created_at = CASE WHEN $10 THEN COALESCE($11, subscription_created_at) ELSE $11 END,
       subscription_modified_at = CASE WHEN $10 THEN COALESCE($12, subscription_modified_at) ELSE $12 END
 WHERE id = $1`;

/**
 * Stores a subscription's state on its workspace, with what it gives: the plan (tier), the package
 * and, while it is live, the products, all in one transaction. A new subscription that is paying
 * (or trialing) becomes the workspace's current one, and the one it replaces stops renewing; any
 * other subscription is ignored. A picture older than the one stored (Polar's `modified_at`), or a
 * subscription started before the running one, changes nothing, so a late event never undoes a
 * newer state, and the same event twice writes the same row.
 */
async function applySubscription(s, { actor = null, workspaceId: known = null } = {}) {
  const checkout = s.checkout_id
    ? (await query("SELECT c.workspace_id, u.id AS user_id, u.name FROM billing_checkouts c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = $1", [s.checkout_id])).rows[0]
    : null;
  const workspaceId = known || checkout?.workspace_id || [s.metadata?.workspace_id, s.customer?.external_id].find((id) => UUID.test(id || "")) || null;
  const offer = offerForPolarProduct(s.product_id);
  if (!workspaceId || !offer) return console.warn(`Polar subscription ${s.id}: no matching workspace or package (product ${s.product_id}).`);
  const { pkg, tier } = offer;
  const live = isPaid(s.status);

  const applied = await tx(async (c) => {
    const ws = (await c.query(LOCKED, [workspaceId, s.modified_at || s.created_at || null, s.created_at || null])).rows[0];
    if (!ws) return console.warn(`Polar subscription ${s.id}: workspace ${workspaceId} no longer exists.`);
    const current = ws.polar_subscription_id === s.id;
    if (current ? ws.stale : !live || (ws.older && isPaid(ws.subscription_status))) return null;
    // What the package before gave: only that can be taken away (none when there was no subscription).
    const before = ws.polar_subscription_id ? packageOf(ws.billing_package) || packageOf("agent") : null;
    const products = live ? productsAfter(ws.products, pkg, before) : ws.products;
    const tried = live ? [...new Set([...ws.trial_products, ...pkg.products])] : ws.trial_products;
    const renewsAt = (s.status === "trialing" && s.trial_end) || s.current_period_end || null;
    await c.query(SAVE, [workspaceId, tier, pkg.key, products, tried, s.id, s.status, renewsAt, Boolean(s.cancel_at_period_end), current, s.created_at || null, s.modified_at || s.created_at || null]);
    return { ws, current };
  });
  if (!applied) return;

  const { ws, current } = applied;
  if (!current || ws.plan !== tier || (ws.billing_package || "agent") !== pkg.key) {
    const who = actor || (checkout?.user_id ? { id: checkout.user_id, name: checkout.name } : null);
    const params = { plan: tier, package: pkg.key };
    if (who) await logActivity(workspaceId, who.id, "{actor} switched to the {plan} plan", { actor: who.name, ...params }, { key: "Paid through Polar" });
    else await logActivity(workspaceId, null, "Subscribed to the {plan} plan", params, { key: "Paid through Polar" });
  }
  // A second subscription replaced the running one; stop the old one renewing. Not awaited: Polar wants a quick reply.
  if (!current && ws.polar_subscription_id && isPaid(ws.subscription_status)) {
    const old = ws.polar_subscription_id;
    cancelAtPeriodEnd(old).catch((e) => console.error(`Couldn't cancel old Polar subscription ${old}: ${e.message}`));
  }
}
