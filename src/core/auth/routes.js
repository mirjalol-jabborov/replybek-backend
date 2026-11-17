import { Router } from "express";
import { wrap } from "../http.js";
import { validate } from "../validate.js";
import { registerSchema, loginSchema, profileSchema } from "./checks.js";
import { rateLimit, clientIP } from "../rate-limit.js";
import { startSession, endSession, requireUser, appOrigins, cookieOptions } from "./session.js";
import { register, login, workspacesOf, googleSignIn, updateProfile } from "./auth.js";
import { googleEnabled, authorizationUrl, exchangeCode } from "./google.js";
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
// After Google the person lands where they started: the dashboard, or another of our addresses
// when the sign-in page named it (?return_to=https://crm.replybek.uz). Only addresses in APP_ORIGIN count.
const appUrl = (error, origin) => `${origin || process.env.APP_ORIGIN || "http://localhost:5173"}/${error ? `?auth_error=${encodeURIComponent(error)}` : ""}#/`;
const returnIndex = (asked) => Math.max(0, appOrigins().indexOf(String(asked || "").replace(/\/+$/, "")));
// Same options as the session cookie, Domain included: a sign-in started at the CRM's address comes
// back through the dashboard's callback, and the cookie has to reach it there.
const googleCookie = (value, maxAge) => serialize(GOOGLE_COOKIE, value, cookieOptions(maxAge));

router.get("/google", limiter, (req, res) => {
  const back = returnIndex(req.query.return_to);
  if (!googleEnabled()) return res.redirect(appUrl("Google sign-in isn't set up yet.", appOrigins()[back]));
  const { url, state, verifier } = authorizationUrl();
  // The cookie also remembers where to return and which product a new account is for (?product=crm).
  res.setHeader("Set-Cookie", googleCookie(`${state}.${verifier}.${back}.${req.query.product === "crm" ? "crm" : "agent"}`, 600));
  res.redirect(url);
});

router.get("/google/callback", limiter, wrap(async (req, res) => {
  const [state, verifier, back, product] = (parse(req.headers.cookie || "")[GOOGLE_COOKIE] || "").split(".");
  const home = appOrigins()[Number(back)] || undefined;
  const clear = googleCookie("", 0);
  if (req.query.error) return res.setHeader("Set-Cookie", clear).redirect(appUrl(req.query.error === "access_denied" ? "Google sign-in was cancelled." : "Google sign-in didn't finish. Try again.", home));
  if (!state || !verifier || req.query.state !== state || typeof req.query.code !== "string") {
    return res.setHeader("Set-Cookie", clear).redirect(appUrl("That Google sign-in link expired. Try again.", home));
  }
  try {
    const { user } = await googleSignIn(await exchangeCode(req.query.code, verifier), product === "crm" ? "crm" : "agent");
    await startSession(res, user.id);
    res.append("Set-Cookie", clear);
    res.redirect(appUrl(null, home));
  } catch (e) {
    if (!e.status) console.error(e.message);
    res.setHeader("Set-Cookie", clear).redirect(appUrl(e.status ? e.message : "Google sign-in didn't finish. Try again.", home));
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
