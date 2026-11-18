import { Router } from "express";
import { wrap } from "../http.js";
import { validate } from "../validate.js";
import { planSchema, checkoutSchema, portalSchema } from "./checks.js";
import { requireRole } from "../workspaces/access.js";
import { rateLimit } from "../rate-limit.js";
import { changePlan } from "../workspaces/workspaces.js";
import { startCheckout, billingPortal, syncSubscription, defaultPackage } from "./billing.js";
import { catalogue, packageOf } from "./packages.js";
import { productsBilling, runningSubscription } from "./product-access.js";

const router = Router({ mergeParams: true });
const admin = requireRole("admin");
const owner = requireRole("owner");
// Checking with Polar costs a call to them, and nobody needs to check twice a second.
const syncLimit = rateLimit({ windowMs: 60 * 1000, max: 10, key: (req) => req.user.id, message: "Checking too often. Wait a minute." });

function offerOf(req) {
  const { valid: v, workspace } = req;
  return { pkg: v.package ? packageOf(v.package) : defaultPackage(workspace), tier: v.tier || v.plan, options: { returnTo: v.return_to, origin: v.origin } };
}

// Without Polar configured, switching only changes the stored plan (no payment). With Polar, the owner
// gets a checkout link (or a running subscription switches product) and Polar's webhook confirms it.
router.patch("/plan", owner, validate(planSchema), wrap(async (req, res) => res.json(await changePlan(req.workspace, req.valid.plan, req.user))));
router.post("/billing/checkout", owner, validate(checkoutSchema), wrap(async (req, res) => {
  const { pkg, tier, options } = offerOf(req);
  res.json(await startCheckout(req.workspace, { pkg, tier }, req.user, options));
}));
// What is sold, what the workspace may do with each product, and what its running subscription costs.
router.get("/billing/packages", wrap(async (req, res) => res.json({ packages: catalogue(), products: productsBilling(req.workspace), subscription: runningSubscription(req.workspace) })));
// Picks up a subscription whose webhook never arrived, so a paid workspace can unlock itself.
router.post("/billing/sync", admin, syncLimit, wrap(async (req, res) => res.json(await syncSubscription(req.workspace, { actor: req.user }))));
router.post("/billing/portal", owner, validate(portalSchema), wrap(async (req, res) => res.json(await billingPortal(req.workspace, req.valid))));

export default router;
