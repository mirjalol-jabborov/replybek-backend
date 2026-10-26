import { Router } from "express";
import { wrap } from "../lib/http.js";
import { validate, joinSchema, forgotSchema, resetSchema } from "../validators.js";
import { rateLimit, clientIP } from "../middlewares/rateLimit.js";
import { startSession, requireUser } from "../middlewares/session.js";
import { languageOf } from "../services/suggestions.service.js";
import { workspacesOf } from "../services/auth.service.js";
import { inviteInfo, acceptInvite, joinWithInvite, forgotPassword, resetPassword } from "../services/team.service.js";

// Joining a workspace from an emailed invitation, and "forgot password". Mounted at /invites and
// /auth/password; the person may not be signed in yet.
export const invites = Router();
export const password = Router();
const limiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, key: clientIP, message: "Too many attempts. Try again in a few minutes." });

invites.get("/:token", limiter, wrap(async (req, res) => res.json(await inviteInfo(req.params.token))));
// Signed in already: accept with that account (the address must match the invitation).
invites.post("/:token/accept", limiter, requireUser, wrap(async (req, res) => res.json(await acceptInvite(req.params.token, req.user))));
// No account yet: create one for the invited address and sign in.
invites.post("/:token/join", limiter, validate(joinSchema), wrap(async (req, res) => {
  const { user, workspace_id, workspaces } = await joinWithInvite(req.params.token, req.valid);
  await startSession(res, user.id);
  res.status(201).json({ user, workspace_id, workspaces });
}));

// Always the same answer, so the form doesn't reveal who has an account.
password.post("/forgot", limiter, validate(forgotSchema), wrap(async (req, res) => {
  await forgotPassword(req.valid.email, languageOf(req.headers["accept-language"]));
  res.json({ ok: true });
}));
password.post("/reset", limiter, validate(resetSchema), wrap(async (req, res) => {
  const user = await resetPassword(req.valid.token, req.valid.password);
  await startSession(res, user.id);
  res.json({ user, workspaces: await workspacesOf(user.id) });
}));
