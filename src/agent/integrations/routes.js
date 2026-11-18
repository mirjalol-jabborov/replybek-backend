import { Router } from "express";
import multer from "multer";
import { wrap } from "../../core/http.js";
import { validate } from "../../core/validate.js";
import { requireRole } from "../../core/workspaces/access.js";
import { testLimit, setupAILimit } from "../shared/limits.js";
import { integrationImportSchema, procedureTestSchema, integrationTestSchema, integrationSchema, integrationUpdateSchema, toolPreviewSchema } from "./checks.js";
import { languageOf } from "../answers/suggestions.js";
import { listIntegrations, createIntegration, updateIntegration, deleteIntegration, loadIntegration } from "./integrations.js";
import { redirectUri } from "./connections.js";
import { previewTool } from "./requests.js";
import { simulateProcedure } from "./procedures.js";
import { importDefinition } from "./import.js";
import { exportPackage } from "./package.js";
import { testIntegration, getBrowserTest } from "./testing.js";
import { integrationAISchema, generateIntegration } from "./ai-draft.js";
import { startIntegrationDraft, getIntegrationDraft, retryIntegrationDraft, cancelIntegrationDraft } from "./ai-jobs.js";

const router = Router({ mergeParams: true });
const admin = requireRole("admin");
const docsUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 4, fieldSize: 60000 } });

// Integrations (admins): systems the agents can act in for signed-in customers.
router.post("/integrations/ai-jobs", admin, setupAILimit, (req,res,next)=>docsUpload.single("file")(req,res,next), validate(integrationAISchema), wrap(async(req,res)=>{
  res.status(202).json(await startIntegrationDraft(req.workspace.id,req.user.id,req.valid,req.file,languageOf(req.headers["accept-language"])));
}));
router.get("/integrations/ai-jobs/:jid",admin,wrap(async(req,res)=>res.json(await getIntegrationDraft(req.workspace.id,req.params.jid))));
router.post("/integrations/ai-jobs/:jid/retry",admin,setupAILimit,wrap(async(req,res)=>res.json(await retryIntegrationDraft(req.workspace.id,req.params.jid))));
router.post("/integrations/ai-jobs/:jid/cancel",admin,wrap(async(req,res)=>res.json(await cancelIntegrationDraft(req.workspace.id,req.params.jid))));
router.post("/integrations/ai-draft", admin, setupAILimit, (req, res, next) => {
  docsUpload.single("file")(req, res, (err) => {
    if (err?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ message: "Choose documentation smaller than 2 MB." });
    next(err);
  });
}, validate(integrationAISchema), wrap(async (req, res) => {
  res.json(await generateIntegration(req.valid, req.file, languageOf(req.headers["accept-language"])));
}));
router.post("/integrations/import", admin, validate(integrationImportSchema), wrap(async (req,res) => res.json(importDefinition(req.valid.format, req.valid.source))));
router.post("/integrations/simulate-procedure", admin, validate(procedureTestSchema), wrap(async (req,res) => res.json(simulateProcedure(req.valid))));
router.get("/integrations/:iid/export", admin, wrap(async (req,res) => res.json(exportPackage(await loadIntegration(req.workspace.id, req.params.iid)))));
router.post("/integrations/:iid/test", admin, testLimit, validate(integrationTestSchema), wrap(async (req,res) => res.json(await testIntegration(req.workspace.id, req.params.iid, req.valid))));
router.get("/integrations/:iid/tests/:tid", admin, wrap(async (req,res) => res.json(await getBrowserTest(req.workspace.id, req.params.iid, req.params.tid))));
router.get("/integrations/setup", admin, (req, res) => res.json({ redirect_uri: redirectUri() }));
router.get("/integrations", admin, wrap(async (req, res) => res.json(await listIntegrations(req.workspace.id))));
router.post("/integrations", admin, validate(integrationSchema), wrap(async (req, res) => res.status(201).json(await createIntegration(req.workspace, req.user, req.valid))));
router.patch("/integrations/:iid", admin, validate(integrationUpdateSchema), wrap(async (req, res) => res.json(await updateIntegration(req.workspace.id, req.params.iid, req.valid))));
router.delete("/integrations/:iid", admin, wrap(async (req, res) => {
  await deleteIntegration(req.workspace.id, req.params.iid, req.user);
  res.status(204).end();
}));
router.post("/integrations/:iid/tools/:name/preview", admin, validate(toolPreviewSchema), wrap(async (req, res) => res.json(await previewTool(req.workspace.id, req.params.iid, req.params.name, req.valid.args, req.valid.context, { base_url: req.valid.base_url, headers: req.valid.headers, tool: req.valid.tool }))));

export default router;
