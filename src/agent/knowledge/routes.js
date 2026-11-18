import { Router } from "express";
import multer from "multer";
import { wrap } from "../../core/http.js";
import { validate } from "../../core/validate.js";
import { requireRole } from "../../core/workspaces/access.js";
import { rateLimit } from "../../core/rate-limit.js";
import { websitePreviewSchema, websiteSourceSchema, qaSourceSchema, sourceUpdateSchema } from "./checks.js";
import { getAgent } from "../agents/agents.js";
import { listSources, listWorkspaceSources, getSource, addWebsite, previewWebsite, addQA, addFile, retrySource, resyncSource, updateSource, listPages, removeSource, listUnanswered, dismissUnanswered } from "./sources.js";

const router = Router({ mergeParams: true });
const admin = requireRole("admin");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

// Knowledge
router.get("/agents/:aid/sources", wrap(async (req, res) => {
  await getAgent(req.workspace.id, req.params.aid);
  res.json(await listSources(req.workspace.id, req.params.aid));
}));
const previewLimit = rateLimit({ windowMs: 60 * 1000, max: 20, key: (req) => req.user.id, message: "Too many site checks. Wait a minute." });
router.post("/agents/:aid/sources/website/preview", admin, previewLimit, validate(websitePreviewSchema), wrap(async (req, res) => {
  res.json(await previewWebsite(await getAgent(req.workspace.id, req.params.aid), req.valid.url));
}));
router.post("/agents/:aid/sources/website", admin, validate(websiteSourceSchema), wrap(async (req, res) => {
  res.status(202).json(await addWebsite(await getAgent(req.workspace.id, req.params.aid), req.user, req.valid));
}));
router.post("/agents/:aid/sources/qa", admin, validate(qaSourceSchema), wrap(async (req, res) => {
  res.status(202).json(await addQA(await getAgent(req.workspace.id, req.params.aid), req.user, req.valid));
}));
router.post("/agents/:aid/sources/file", admin, upload.single("file"), wrap(async (req, res) => {
  res.status(202).json(await addFile(await getAgent(req.workspace.id, req.params.aid), req.user, req.file));
}));
router.get("/sources", wrap(async (req, res) => {
  const status = ["processing", "ready", "error"].includes(req.query.status) ? req.query.status : null;
  res.json(await listWorkspaceSources(req.workspace.id, status));
}));
router.get("/sources/:sid", wrap(async (req, res) => res.json(await getSource(req.workspace.id, req.params.sid))));
router.get("/sources/:sid/pages", wrap(async (req, res) => {
  const status = ["ready", "error"].includes(req.query.status) ? req.query.status : null;
  res.json(await listPages(req.workspace.id, req.params.sid, { status, q: typeof req.query.q === "string" ? req.query.q.slice(0, 200) : null }));
}));
router.post("/sources/:sid/resync", admin, wrap(async (req, res) => res.status(202).json(await resyncSource(req.workspace.id, req.params.sid))));
router.patch("/sources/:sid", admin, validate(sourceUpdateSchema), wrap(async (req, res) => res.json(await updateSource(req.workspace.id, req.params.sid, req.valid))));
router.post("/sources/:sid/retry", admin, wrap(async (req, res) => res.status(202).json(await retrySource(req.workspace.id, req.params.sid))));
router.delete("/sources/:sid", admin, wrap(async (req, res) => {
  await removeSource(req.workspace.id, req.params.sid, req.user);
  res.status(204).end();
}));
router.get("/unanswered", wrap(async (req, res) => res.json(await listUnanswered(req.workspace.id, req.query.agent))));
router.delete("/unanswered/:uid", admin, wrap(async (req, res) => {
  await dismissUnanswered(req.workspace.id, req.params.uid);
  res.status(204).end();
}));

export default router;
