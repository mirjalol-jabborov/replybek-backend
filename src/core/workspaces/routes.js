import { Router } from "express";
import { wrap } from "../http.js";
import { validate } from "../validate.js";
import { productAddSchema, workspaceUpdateSchema } from "./checks.js";
import { requireRole } from "./access.js";
import { stream } from "../events.js";
import { workspaceSummary, updateWorkspace, listMembers } from "./workspaces.js";
import { addProductOrBuy } from "../billing/billing.js";

// Adding a product sits above the trial lock, with the CRM (see app.js). Once the CRM is billed it
// starts the checkout (or package change) that brings the product.
export const products = Router({ mergeParams: true });
products.post("/products", requireRole("owner"), validate(productAddSchema), wrap(async (req, res) => res.json(await addProductOrBuy(req.workspace, req.valid.add, req.user))));

const router = Router({ mergeParams: true });
const admin = requireRole("admin");

// Workspace
router.get("/", wrap(async (req, res) => res.json(await workspaceSummary(req.workspace, req.role))));
router.patch("/", admin, validate(workspaceUpdateSchema), wrap(async (req, res) => res.json(await updateWorkspace(req.workspace.id, req.valid))));
// Live updates for this workspace's inbox (see core/events.js).
router.get("/stream", wrap((req, res) => stream(req, res, [`w:${req.workspace.id}`])));
router.get("/members", wrap(async (req, res) => res.json(await listMembers(req.workspace.id))));

export default router;
