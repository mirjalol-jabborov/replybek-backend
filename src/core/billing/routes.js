import { Router } from "express";
import { wrap } from "../http.js";
import { validate } from "../validate.js";
import { planSchema, checkoutSchema } from "./checks.js";
import { requireRole } from "../workspaces/access.js";
import { rateLimit } from "../rate-limit.js";
import { changePlan } from "../workspaces/workspaces.js";
import { startCheckout, billingPortal, syncSubscription } from "./billing.js";

const router = Router({ mergeParams: true });
const admin = requireRole("admin");
// Checking with Polar costs a call to them, and nobody needs to check twice a second.
const syncLimit = rateLimit({ windowMs: 60 * 1000, max: 10, key: (req) => req.user.id, message: "Checking too often. Wait a minute." });

// Without Polar configured, switching only changes the stored plan (no payment). With Polar, the owner
// gets a checkout link (or a running subscription switches product) and Polar's webhook confirms it.
router.patch("/plan", requireRole("owner"), validate(planSchema), wrap(async (req, res) => res.json(await changePlan(req.workspace, req.valid.plan, req.user))));
router.post("/billing/checkout", requireRole("owner"), validate(checkoutSchema), wrap(async (req, res) => res.json(await startCheckout(req.workspace, req.valid.plan, req.user, req.valid.return_to))));
// Picks up a subscription whose webhook never arrived, so a paid workspace can unlock itself.
router.post("/billing/sync", admin, syncLimit, wrap(async (req, res) => res.json(await syncSubscription(req.workspace, { actor: req.user }))));
router.post("/billing/portal", requireRole("owner"), wrap(async (req, res) => res.json(await billingPortal(req.workspace))));

export default router;
