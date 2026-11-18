// Core routes of the CRM: settings and customers. Mounted at /w/:wid/crm by ../index.js.
// Team members work with customers; settings and deleting are for admins and the owner.
import { Router } from "express";
import { wrap } from "../../core/http.js";
import { validate } from "../../core/validate.js";
import { requireRole } from "../../core/workspaces/access.js";
import { settingsSchema, saveSettings } from "./settings.js";
import { customerCreateSchema, customerUpdateSchema, searchSchema, createCustomer, updateCustomer, deleteCustomer, customerHistory, searchCustomers } from "./customers.js";

export const router = Router({ mergeParams: true });
const admin = requireRole("admin");

router.put("/settings", admin, validate(settingsSchema), wrap(async (req, res) => res.json(await saveSettings(req.workspace, req.valid))));

router.get("/customers", validate(searchSchema, "query"), wrap(async (req, res) => res.json(await searchCustomers(req.workspace.id, req.valid))));
router.post("/customers", validate(customerCreateSchema), wrap(async (req, res) => res.status(201).json(await createCustomer(req.workspace.id, req.valid))));
router.put("/customers/:id", validate(customerUpdateSchema), wrap(async (req, res) => res.json(await updateCustomer(req.workspace.id, req.params.id, req.valid))));
router.delete("/customers/:id", admin, wrap(async (req, res) => res.json(await deleteCustomer(req.workspace.id, req.params.id))));
router.get("/customers/:id/history", wrap(async (req, res) => res.json(await customerHistory(req.ctx(), req.params.id))));
