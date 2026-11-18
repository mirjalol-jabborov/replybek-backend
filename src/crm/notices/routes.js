// The routes of messages to customers, mounted at /w/:wid/crm. The team reads them; sending a
// failed one again is for admins. Their switches and texts are saved with CRM settings.
import { Router } from "express";
import { wrap } from "../../core/http.js";
import { validate } from "../../core/validate.js";
import { requireRole } from "../../core/workspaces/access.js";
import { listSchema, noticesFor, retryNotice } from "./notices.js";
import { reachOf } from "./reach.js";

export const router = Router({ mergeParams: true });

router.get("/notices/reach", wrap(async (req, res) => res.json(await reachOf(req.workspace))));
router.get("/notices", validate(listSchema, "query"), wrap(async (req, res) => res.json(await noticesFor(req.ctx(), req.valid))));
router.post("/notices/:id/retry", requireRole("admin"), wrap(async (req, res) => res.json(await retryNotice(req.workspace.id, req.params.id))));
