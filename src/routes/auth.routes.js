import { Router } from "express";
import { wrap } from "../lib/http.js";
import { validate, registerSchema, loginSchema } from "../validators.js";
import { rateLimit, clientIP } from "../middlewares/rateLimit.js";
import { startSession, endSession, requireUser } from "../middlewares/session.js";
import { register, login, workspacesOf } from "../services/auth.service.js";

const router = Router();

// 30 tries in 10 minutes from one address is plenty for a person, little for a guesser.
const limiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, key: clientIP, message: "Too many sign-in attempts. Try again in a few minutes." });

router.post("/register", limiter, validate(registerSchema), wrap(async (req, res) => {
  const { user, workspace } = await register(req.valid);
  await startSession(res, user.id);
  res.status(201).json({ user, workspaces: [{ ...workspace, role: "owner" }] });
}));

router.post("/login", limiter, validate(loginSchema), wrap(async (req, res) => {
  const user = await login(req.valid);
  await startSession(res, user.id);
  res.json({ user, workspaces: await workspacesOf(user.id) });
}));

router.post("/logout", wrap(async (req, res) => {
  await endSession(req, res);
  res.status(204).end();
}));

router.get("/me", requireUser, wrap(async (req, res) => {
  res.json({ user: req.user, workspaces: await workspacesOf(req.user.id) });
}));

export default router;
