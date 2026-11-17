import { Router } from "express";
import { wrap } from "../../core/http.js";
import { validate } from "../../core/validate.js";
import { replySchema, assignSchema } from "./checks.js";
import * as convs from "./conversations.js";
import { acceptFile, workspaceAttachment, sendAttachment } from "./attachments.js";

const router = Router({ mergeParams: true });

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
router.post("/conversations/:cid/reply", acceptFile, validate(replySchema), withFile(convs.reply));
router.post("/conversations/:cid/note", acceptFile, validate(replySchema), withFile(convs.addNote));
router.get("/files/:fid", wrap(async (req, res) => sendAttachment(res, await workspaceAttachment(req.workspace.id, req.params.fid))));
router.get("/conversations/:cid/avatar", wrap(async (req, res) => convs.visitorAvatar(req.workspace.id, req.params.cid, res)));
router.post("/conversations/:cid/typing", wrap(async (req, res) => res.json(await convs.teamTyping(req.workspace.id, req.params.cid, req.user))));
router.post("/conversations/:cid/resolve", action(convs.resolve));
router.post("/conversations/:cid/reopen", action(convs.reopen));
router.post("/conversations/:cid/assign", validate(assignSchema), wrap(async (req, res) => res.json(await convs.assign(req.workspace.id, req.params.cid, req.user, req.valid.user_id))));
router.post("/conversations/:cid/unread", wrap(async (req, res) => {
  await convs.markUnread(req.workspace.id, req.params.cid);
  res.status(204).end();
}));

export default router;
