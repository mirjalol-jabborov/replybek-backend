import { Router } from "express";
import { wrap } from "../lib/http.js";
import { validate, registerSchema, loginSchema, profileSchema } from "../validators.js";
import { rateLimit, clientIP } from "../middlewares/rateLimit.js";
import { startSession, endSession, requireUser } from "../middlewares/session.js";
import { register, login, workspacesOf, googleSignIn, updateProfile } from "../services/auth.service.js";
import { googleEnabled, authorizationUrl, exchangeCode } from "../lib/google.js";
import { parse, serialize } from "cookie";

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

// Which sign-in methods the sign-in page offers.
router.get("/providers", (req, res) => res.json({ google: googleEnabled() }));

// "Continue with Google": the state and PKCE verifier ride in a short-lived cookie for the round trip.
const GOOGLE_COOKIE = "rb_google";
const appUrl = (error) => `${process.env.APP_ORIGIN || "http://localhost:5173"}/${error ? `?auth_error=${encodeURIComponent(error)}` : ""}#/`;
const googleCookie = (value, maxAge) => serialize(GOOGLE_COOKIE, value, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge });

router.get("/google", limiter, (req, res) => {
  if (!googleEnabled()) return res.redirect(appUrl("Google sign-in isn't set up yet."));
  const { url, state, verifier } = authorizationUrl();
  res.setHeader("Set-Cookie", googleCookie(`${state}.${verifier}`, 600));
  res.redirect(url);
});

router.get("/google/callback", limiter, wrap(async (req, res) => {
  const [state, verifier] = (parse(req.headers.cookie || "")[GOOGLE_COOKIE] || "").split(".");
  const clear = googleCookie("", 0);
  if (req.query.error) return res.setHeader("Set-Cookie", clear).redirect(appUrl(req.query.error === "access_denied" ? "Google sign-in was cancelled." : "Google sign-in didn't finish. Try again."));
  if (!state || !verifier || req.query.state !== state || typeof req.query.code !== "string") {
    return res.setHeader("Set-Cookie", clear).redirect(appUrl("That Google sign-in link expired. Try again."));
  }
  try {
    const { user } = await googleSignIn(await exchangeCode(req.query.code, verifier));
    await startSession(res, user.id);
    res.append("Set-Cookie", clear);
    res.redirect(appUrl());
  } catch (e) {
    if (!e.status) console.error(e.message);
    res.setHeader("Set-Cookie", clear).redirect(appUrl(e.status ? e.message : "Google sign-in didn't finish. Try again."));
  }
}));

router.post("/logout", wrap(async (req, res) => {
  await endSession(req, res);
  res.status(204).end();
}));

router.get("/me", requireUser, wrap(async (req, res) => {
  res.json({ user: req.user, workspaces: await workspacesOf(req.user.id) });
}));
router.patch("/me", requireUser, validate(profileSchema), wrap(async (req, res) => {
  res.json({ user: await updateProfile(req.user.id, req.valid), workspaces: await workspacesOf(req.user.id) });
}));

export default router;
