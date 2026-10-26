import { Router } from "express";
import multer from "multer";
import { wrap } from "../lib/http.js";
import * as v from "../validators.js";
import { requireWorkspace, requireRole, readOnlyUntilTrial } from "../middlewares/workspace.js";
import { rateLimit } from "../middlewares/rateLimit.js";
import { workspaceSummary, updateWorkspace, listMembers } from "../services/workspaces.service.js";
import { listAgents, getAgent, createAgent, updateAgent, setAgentStatus, deleteAgent } from "../services/agents.service.js";
import { listSources, listWorkspaceSources, getSource, addWebsite, previewWebsite, addQA, addFile, retrySource, resyncSource, updateSource, listPages, removeSource, listUnanswered, dismissUnanswered } from "../services/sources.service.js";
import { answerQuestion } from "../services/answer.service.js";
import * as convs from "../services/conversations.service.js";
import { listActivity } from "../services/activity.service.js";
import { stream } from "../services/events.service.js";
import { acceptFile, workspaceAttachment, sendAttachment } from "../services/attachments.service.js";
import { listInvites, createInvite, resendInvite, revokeInvite, updateMemberRole, removeMember } from "../services/team.service.js";
import { analytics } from "../services/analytics.service.js";
import { changePlan } from "../services/workspaces.service.js";
import { startCheckout, billingPortal } from "../services/billing.service.js";
import { analyzeSite, completeOnboarding } from "../services/onboarding.service.js";
import { listIntegrations, createIntegration, updateIntegration, deleteIntegration, redirectUri, previewTool, loadIntegration, simulateProcedure } from "../services/integrations.service.js";

import { importDefinition, exportPackage } from "../lib/integration-config.js";
import { testIntegration, getBrowserTest } from "../services/integration-testing.service.js";
import { suggestedQuestions, translateQuestions, languageOf } from "../services/suggestions.service.js";
import { integrationAISchema, generateIntegration } from "../services/integration-ai.service.js";
import { startIntegrationDraft, getIntegrationDraft, retryIntegrationDraft, cancelIntegrationDraft } from "../services/integration-ai-jobs.service.js";

// Everything here is scoped to /w/:wid, and every query filters by that workspace.
const router = Router({ mergeParams: true });
router.use(requireWorkspace);
router.use(readOnlyUntilTrial);
const admin = requireRole("admin");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
const testLimit = rateLimit({ windowMs: 60 * 1000, max: 30, key: (req) => req.user.id, message: "Too many test questions. Wait a minute." });
const setupAILimit = rateLimit({ windowMs: 60 * 1000, max: 6, key: (req) => req.user.id, message: "Too many AI setup requests. Wait a minute." });
const docsUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 4, fieldSize: 60000 } });

// Workspace
router.get("/", wrap(async (req, res) => res.json(await workspaceSummary(req.workspace, req.role))));
router.patch("/", admin, v.validate(v.workspaceUpdateSchema), wrap(async (req, res) => res.json(await updateWorkspace(req.workspace.id, req.valid))));
// Live updates for this workspace's inbox (see events.service.js).
router.get("/stream", wrap((req, res) => stream(req, res, [`w:${req.workspace.id}`])));
router.get("/members", wrap(async (req, res) => res.json(await listMembers(req.workspace.id))));
// Team: invitations by email, roles, removal (admins only).
const lang = (req) => languageOf(req.headers["accept-language"]);
router.get("/invites", admin, wrap(async (req, res) => res.json(await listInvites(req.workspace.id))));
router.post("/invites", admin, v.validate(v.inviteSchema), wrap(async (req, res) => res.status(201).json(await createInvite(req.workspace, req.user, req.valid, lang(req)))));
router.post("/invites/:iid/resend", admin, wrap(async (req, res) => res.json(await resendInvite(req.workspace, req.user, req.params.iid, lang(req)))));
router.delete("/invites/:iid", admin, wrap(async (req, res) => {
  await revokeInvite(req.workspace.id, req.params.iid);
  res.status(204).end();
}));
router.patch("/members/:uid", admin, v.validate(v.memberRoleSchema), wrap(async (req, res) => {
  await updateMemberRole(req.workspace.id, req.user, req.params.uid, req.valid.role);
  res.json(await listMembers(req.workspace.id));
}));
router.delete("/members/:uid", admin, wrap(async (req, res) => {
  await removeMember(req.workspace.id, req.user, req.params.uid);
  res.status(204).end();
}));
router.get("/activity", wrap(async (req, res) => res.json(await listActivity(req.workspace.id))));
router.get("/analytics", v.validate(v.analyticsQuerySchema, "query"), wrap(async (req, res) => {
  res.json(await analytics(req.workspace, { days: req.valid.days, agentId: req.valid.agent || null }));
}));
// Without Polar configured, switching only changes the stored plan (no payment). With Polar, the owner
// gets a checkout link (or a running subscription switches product) and Polar's webhook confirms it.
router.patch("/plan", requireRole("owner"), v.validate(v.planSchema), wrap(async (req, res) => res.json(await changePlan(req.workspace, req.valid.plan, req.user))));
router.post("/billing/checkout", requireRole("owner"), v.validate(v.checkoutSchema), wrap(async (req, res) => res.json(await startCheckout(req.workspace, req.valid.plan, req.user, req.valid.return_to))));
router.post("/billing/portal", requireRole("owner"), wrap(async (req, res) => res.json(await billingPortal(req.workspace))));

// Onboarding: read the business's website, then (in the dashboard) create the first agent from it.
const analyzeLimit = rateLimit({ windowMs: 60 * 1000, max: 10, key: (req) => req.user.id, message: "Too many website checks. Wait a minute." });
router.post("/onboarding/analyze", admin, analyzeLimit, v.validate(v.websitePreviewSchema), wrap(async (req, res) => res.json(await analyzeSite(req.workspace, req.valid.url))));
router.post("/onboarding/complete", admin, v.validate(v.onboardingCompleteSchema), wrap(async (req, res) => res.json(await completeOnboarding(req.workspace, req.valid.website))));

// Agents
router.get("/agents", wrap(async (req, res) => res.json(await listAgents(req.workspace.id))));
router.post("/agents", admin, v.validate(v.agentCreateSchema), wrap(async (req, res) => res.status(201).json(await createAgent(req.workspace, req.user, req.valid))));
router.get("/agents/:aid", wrap(async (req, res) => res.json(await getAgent(req.workspace.id, req.params.aid))));
router.patch("/agents/:aid", admin, v.validate(v.agentUpdateSchema), wrap(async (req, res) => res.json(await updateAgent(req.workspace.id, req.params.aid, req.valid))));
router.post("/agents/:aid/publish", admin, wrap(async (req, res) => res.json(await setAgentStatus(req.workspace.id, req.params.aid, "active", req.user))));
router.post("/agents/:aid/unpublish", admin, wrap(async (req, res) => res.json(await setAgentStatus(req.workspace.id, req.params.aid, "draft", req.user))));
router.delete("/agents/:aid", admin, wrap(async (req, res) => {
  await deleteAgent(req.workspace.id, req.params.aid, req.user);
  res.status(204).end();
}));

// Playground: answers with unsaved settings; nothing is stored except usage.
router.post("/agents/:aid/suggestions/generate", admin, setupAILimit, v.validate(v.suggestionDraftSchema), wrap(async (req, res) => {
  const agent = await getAgent(req.workspace.id, req.params.aid);
  const language = req.valid.language || languageOf(req.headers["accept-language"]);
  res.json(req.valid.questions ? await translateQuestions(req.valid.questions, language) : await suggestedQuestions(agent, language));
}));
router.post("/agents/:aid/test", testLimit, v.validate(v.testQuestionSchema), wrap(async (req, res) => {
  const agent = await getAgent(req.workspace.id, req.params.aid);
  res.json(await answerQuestion({ agent, question: req.valid.question, history: req.valid.history, draft: req.valid.draft, playground: true }));
}));

// Knowledge
router.get("/agents/:aid/sources", wrap(async (req, res) => {
  await getAgent(req.workspace.id, req.params.aid);
  res.json(await listSources(req.workspace.id, req.params.aid));
}));
const previewLimit = rateLimit({ windowMs: 60 * 1000, max: 20, key: (req) => req.user.id, message: "Too many site checks. Wait a minute." });
router.post("/agents/:aid/sources/website/preview", admin, previewLimit, v.validate(v.websitePreviewSchema), wrap(async (req, res) => {
  res.json(await previewWebsite(await getAgent(req.workspace.id, req.params.aid), req.valid.url));
}));
router.post("/agents/:aid/sources/website", admin, v.validate(v.websiteSourceSchema), wrap(async (req, res) => {
  res.status(202).json(await addWebsite(await getAgent(req.workspace.id, req.params.aid), req.user, req.valid));
}));
router.post("/agents/:aid/sources/qa", admin, v.validate(v.qaSourceSchema), wrap(async (req, res) => {
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
router.patch("/sources/:sid", admin, v.validate(v.sourceUpdateSchema), wrap(async (req, res) => res.json(await updateSource(req.workspace.id, req.params.sid, req.valid))));
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

// Inbox
router.get("/conversations", wrap(async (req, res) => {
  const { view, agent, q } = req.query;
  res.json(await convs.listConversations(req.workspace.id, req.user.id, { view, agent: agent && agent !== "all" ? agent : null, q }));
}));
router.get("/conversations/:cid", wrap(async (req, res) => res.json(await convs.getConversation(req.workspace.id, req.params.cid))));
const action = (fn) => wrap(async (req, res) => res.json(await fn(req.workspace.id, req.params.cid, req.user, req.valid?.text)));
router.post("/conversations/:cid/takeover", action(convs.takeOver));
router.post("/conversations/:cid/hand-back", action(convs.handBack));
const withFile = (fn) => wrap(async (req, res) => res.json(await fn(req.workspace.id, req.params.cid, req.user, req.valid.text, req.file)));
router.post("/conversations/:cid/reply", acceptFile, v.validate(v.replySchema), withFile(convs.reply));
router.post("/conversations/:cid/note", acceptFile, v.validate(v.replySchema), withFile(convs.addNote));
router.get("/files/:fid", wrap(async (req, res) => sendAttachment(res, await workspaceAttachment(req.workspace.id, req.params.fid))));
router.post("/conversations/:cid/resolve", action(convs.resolve));
router.post("/conversations/:cid/reopen", action(convs.reopen));
router.post("/conversations/:cid/assign", v.validate(v.assignSchema), wrap(async (req, res) => res.json(await convs.assign(req.workspace.id, req.params.cid, req.user, req.valid.user_id))));
router.post("/conversations/:cid/unread", wrap(async (req, res) => {
  await convs.markUnread(req.workspace.id, req.params.cid);
  res.status(204).end();
}));

// Integrations (admins): systems the agents can act in for signed-in customers.
router.post("/integrations/ai-jobs", admin, setupAILimit, (req,res,next)=>docsUpload.single("file")(req,res,next), v.validate(integrationAISchema), wrap(async(req,res)=>{
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
}, v.validate(integrationAISchema), wrap(async (req, res) => {
  res.json(await generateIntegration(req.valid, req.file, languageOf(req.headers["accept-language"])));
}));
router.post("/integrations/import", admin, v.validate(v.integrationImportSchema), wrap(async (req,res) => res.json(importDefinition(req.valid.format, req.valid.source))));
router.post("/integrations/simulate-procedure", admin, v.validate(v.procedureTestSchema), wrap(async (req,res) => res.json(simulateProcedure(req.valid))));
router.get("/integrations/:iid/export", admin, wrap(async (req,res) => res.json(exportPackage(await loadIntegration(req.workspace.id, req.params.iid)))));
router.post("/integrations/:iid/test", admin, testLimit, v.validate(v.integrationTestSchema), wrap(async (req,res) => res.json(await testIntegration(req.workspace.id, req.params.iid, req.valid))));
router.get("/integrations/:iid/tests/:tid", admin, wrap(async (req,res) => res.json(await getBrowserTest(req.workspace.id, req.params.iid, req.params.tid))));
router.get("/integrations/setup", admin, (req, res) => res.json({ redirect_uri: redirectUri() }));
router.get("/integrations", admin, wrap(async (req, res) => res.json(await listIntegrations(req.workspace.id))));
router.post("/integrations", admin, v.validate(v.integrationSchema), wrap(async (req, res) => res.status(201).json(await createIntegration(req.workspace, req.user, req.valid))));
router.patch("/integrations/:iid", admin, v.validate(v.integrationUpdateSchema), wrap(async (req, res) => res.json(await updateIntegration(req.workspace.id, req.params.iid, req.valid))));
router.delete("/integrations/:iid", admin, wrap(async (req, res) => {
  await deleteIntegration(req.workspace.id, req.params.iid, req.user);
  res.status(204).end();
}));
router.post("/integrations/:iid/tools/:name/preview", admin, v.validate(v.toolPreviewSchema), wrap(async (req, res) => res.json(await previewTool(req.workspace.id, req.params.iid, req.params.name, req.valid.args, req.valid.context, { base_url: req.valid.base_url, headers: req.valid.headers, tool: req.valid.tool }))));

export default router;
