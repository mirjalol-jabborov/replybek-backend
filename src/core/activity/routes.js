import { Router } from "express";
import { wrap } from "../http.js";
import { listActivity } from "./activity.js";

const router = Router({ mergeParams: true });
router.get("/activity", wrap(async (req, res) => res.json(await listActivity(req.workspace.id))));

export default router;
