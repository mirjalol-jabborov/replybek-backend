import { Router } from "express";
import { wrap } from "../http.js";
import { validate } from "../validate.js";
import { inviteSchema, memberRoleSchema } from "./checks.js";
import { requireRole } from "../workspaces/access.js";
import { listMembers } from "../workspaces/workspaces.js";
import { languageOf } from "../languages.js";
import { listInvites, createInvite, resendInvite, revokeInvite, updateMemberRole, removeMember } from "./team.js";

const router = Router({ mergeParams: true });
const admin = requireRole("admin");
// Team: invitations by email, roles, removal (admins only).
const lang = (req) => languageOf(req.headers["accept-language"]);
router.get("/invites", admin, wrap(async (req, res) => res.json(await listInvites(req.workspace.id))));
router.post("/invites", admin, validate(inviteSchema), wrap(async (req, res) => res.status(201).json(await createInvite(req.workspace, req.user, req.valid, lang(req)))));
router.post("/invites/:iid/resend", admin, wrap(async (req, res) => res.json(await resendInvite(req.workspace, req.user, req.params.iid, lang(req)))));
router.delete("/invites/:iid", admin, wrap(async (req, res) => {
  await revokeInvite(req.workspace.id, req.params.iid);
  res.status(204).end();
}));
router.patch("/members/:uid", admin, validate(memberRoleSchema), wrap(async (req, res) => {
  await updateMemberRole(req.workspace.id, req.user, req.params.uid, req.valid.role);
  res.json(await listMembers(req.workspace.id));
}));
router.delete("/members/:uid", admin, wrap(async (req, res) => {
  await removeMember(req.workspace.id, req.user, req.params.uid);
  res.status(204).end();
}));

export default router;
