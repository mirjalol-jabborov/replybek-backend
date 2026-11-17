import { Router } from "express";
import { wrap } from "../../core/http.js";
import { validate } from "../../core/validate.js";
import { requireRole } from "../../core/workspaces/access.js";
import { agentCreateSchema, agentUpdateSchema } from "./checks.js";
import { listAgents, getAgent, createAgent, updateAgent, setAgentStatus, deleteAgent } from "./agents.js";

const router = Router({ mergeParams: true });
const admin = requireRole("admin");

// Agents
router.get("/agents", wrap(async (req, res) => res.json(await listAgents(req.workspace.id))));
router.post("/agents", admin, validate(agentCreateSchema), wrap(async (req, res) => res.status(201).json(await createAgent(req.workspace, req.user, req.valid))));
router.get("/agents/:aid", wrap(async (req, res) => res.json(await getAgent(req.workspace.id, req.params.aid))));
router.patch("/agents/:aid", admin, validate(agentUpdateSchema), wrap(async (req, res) => res.json(await updateAgent(req.workspace.id, req.params.aid, req.valid))));
router.post("/agents/:aid/publish", admin, wrap(async (req, res) => res.json(await setAgentStatus(req.workspace.id, req.params.aid, "active", req.user))));
router.post("/agents/:aid/unpublish", admin, wrap(async (req, res) => res.json(await setAgentStatus(req.workspace.id, req.params.aid, "draft", req.user))));
router.delete("/agents/:aid", admin, wrap(async (req, res) => {
  await deleteAgent(req.workspace.id, req.params.aid, req.user);
  res.status(204).end();
}));

export default router;
