// What a workspace may do with each product, from its subscription. One decision for both
// products: the AI agent's read-only lock (readOnlyUntilTrial) and the CRM's (requireProduct) ask
// the same functions, and the workspace summary shows what they decide.
import { HttpError } from "../http.js";
import { billingAccess, graceEndsAt, overdue } from "../workspaces/workspaces.js";
import { PRODUCTS } from "../workspaces/checks.js";
import { billed, offerFor, packageOfWorkspace } from "./packages.js";

/**
 * null (the product is free, everything allowed), "trial", "paid", "none" (the workspace doesn't
 * have it, or no subscription gives it) or "ended" (it gave it and ended, or is past due beyond the
 * grace period). This also decides whether the AI agent may answer (assertCanAnswer).
 * Without a product: the workspace's subscription, whatever its package (the routes every
 * workspace has).
 */
export function productAccess(workspace, product = null) {
  if (!product) return billingAccess(workspace);
  if (!billed(product)) return null;
  if (!workspace.products?.includes(product)) return "none";
  const access = billingAccess(workspace);
  if (access === "none") return "none";
  return packageOfWorkspace(workspace).products.includes(product) ? access : "none";
}

/**
 * Why a write is refused while the product is read-only, as a 402 the app turns into one prompt by
 * its code, or null when writes are allowed. `offer` is the package and tier that would lift it.
 */
export function writeRefusal(workspace, product = null) {
  const access = productAccess(workspace, product);
  if (access !== "none" && access !== "ended") return null;
  const about = { reason: "read_only", ...(product ? { product } : {}) };
  if (access === "ended" && overdue(workspace)) {
    return new HttpError(402, "Your last payment didn't go through. Update your card on Polar to make changes.", { code: "subscription_ended", overdue: true, ...about });
  }
  const offer = offerFor(workspace, product);
  if (access === "ended") return new HttpError(402, "Your subscription has ended. Choose a plan to make changes.", { code: "subscription_ended", ...about, offer });
  if (offer?.trial_days) return new HttpError(402, `Start your ${offer.trial_days}-day free trial to make changes.`, { code: "trial_required", ...about, offer });
  return new HttpError(402, "Choose a plan to make changes.", { code: "package_required", ...about, offer });
}

/**
 * For each product: whether the workspace has it, its access (null while off), and what the owner
 * can do next: "add" (free, POST /products), "start_trial" or "buy" (the `offer`, through
 * checkout), "update_card" (Polar's portal), or null.
 */
export function productsBilling(workspace) {
  const result = {};
  for (const product of PRODUCTS) {
    const on = Boolean(workspace.products?.includes(product));
    const access = productAccess(workspace, product);
    const offer = billed(product) ? offerFor(workspace, product) : null;
    const buy = offer?.trial_days ? "start_trial" : "buy";
    let next = null;
    if (!on) next = offer ? buy : "add";
    else if (access === "none") next = buy;
    else if (access === "ended") next = overdue(workspace) ? "update_card" : "buy";
    else if (access && graceEndsAt(workspace)) next = "update_card";
    result[product] = { on, access: on ? access : null, next, offer: next === "buy" || next === "start_trial" ? offer : null };
  }
  return result;
}
