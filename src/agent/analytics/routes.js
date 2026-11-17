import { Router } from "express";
import { wrap } from "../../core/http.js";
import { validate } from "../../core/validate.js";
import { analyticsQuerySchema } from "./checks.js";
import { analytics } from "./analytics.js";

const router = Router({ mergeParams: true });
router.get("/analytics", validate(analyticsQuerySchema, "query"), wrap(async (req, res) => {
  res.json(await analytics(req.workspace, { days: req.valid.days, agentId: req.valid.agent || null }));
}));

export default router;
