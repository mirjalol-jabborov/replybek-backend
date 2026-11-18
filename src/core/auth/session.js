import crypto from "crypto";
import { serialize } from "cookie";
import { query } from "../db.js";
import { HttpError } from "../http.js";

export const COOKIE = "nx_session";
const DAYS = 30;
const hash = (token) => crypto.createHash("sha256").update(token).digest("hex");
const secure = () => process.env.NODE_ENV === "production";
// The dashboard and the CRM can live at two addresses (app.replybek.uz, crm.replybek.uz). With
// COOKIE_DOMAIN set to what they share ("replybek.uz") the session cookie carries Domain, so
// signing in at one signs you in at the other. Without it the cookie belongs to the host that set
// it. Every host under that domain receives the cookie, so set it only when all of them are ours.
export const cookieOptions = (maxAge) => ({ httpOnly: true, sameSite: "lax", secure: secure(), path: "/", maxAge, ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}) });
// Turning COOKIE_DOMAIN on leaves the host-only cookie from before in the browser: a different
// cookie with the same name, sent ahead of the shared one. Every sign-in and sign-out clears it.
const sessionCookies = (token, maxAge) => {
  const shared = serialize(COOKIE, token, cookieOptions(maxAge));
  if (!process.env.COOKIE_DOMAIN) return shared;
  return [shared, serialize(COOKIE, "", { httpOnly: true, sameSite: "lax", secure: secure(), path: "/", maxAge: 0 })];
};
/** Every session token the browser sent. Until the old host-only cookie is cleared there can be two. */
const tokensOf = (req) =>
  String(req.headers.cookie || "")
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.startsWith(`${COOKIE}=`))
    .map((pair) => pair.slice(COOKIE.length + 1).trim())
    .filter(Boolean);

let origins;
/**
 * The addresses that may call the API with the session cookie. APP_ORIGIN lists them, the
 * dashboard first: "https://app.replybek.uz,https://crm.replybek.uz". Outside production the CRM
 * app's own dev address is allowed too.
 * Links in emails, billing returns and the Google callback are built from one address, so once
 * the list is read APP_ORIGIN itself is narrowed to the first one.
 */
export function appOrigins() {
  if (origins) return origins;
  origins = String(process.env.APP_ORIGIN || "http://localhost:5173").split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean);
  process.env.APP_ORIGIN = origins[0];
  if (process.env.NODE_ENV !== "production" && !origins.includes("http://localhost:5192")) origins.push("http://localhost:5192");
  return origins;
}

export async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  await query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))", [hash(token), userId, DAYS]);
  res.setHeader("Set-Cookie", sessionCookies(token, DAYS * 86400));
}

export async function endSession(req, res) {
  const tokens = tokensOf(req);
  if (tokens.length) await query("DELETE FROM sessions WHERE token_hash = ANY($1)", [tokens.map(hash)]);
  res.setHeader("Set-Cookie", sessionCookies("", 0));
}

/** Requires a signed-in user; loads it into req.user. */
export async function requireUser(req, res, next) {
  try {
    const tokens = tokensOf(req);
    if (!tokens.length) throw new HttpError(401, "Sign in required");
    const { rows } = await query(
      `SELECT u.id, u.name, u.email, u.avatar, u.lang FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ANY($1) AND s.expires_at > now() ORDER BY s.expires_at DESC LIMIT 1`,
      [tokens.map(hash)]
    );
    if (!rows[0]) throw new HttpError(401, "Your session expired. Sign in again.");
    const { lang, ...user } = rows[0];
    req.user = user;
    // The dashboard sends its language with every request; emails to this person follow it.
    // Only an explicit en/uz/ru counts ("*" or another language says nothing about the dashboard).
    const asked = String(req.headers["accept-language"] || "").toLowerCase().split(/[-,;]/)[0];
    const now = ["en", "uz", "ru"].includes(asked) ? asked : null;
    if (now && now !== lang) await query("UPDATE users SET lang = $2 WHERE id = $1", [user.id, now]);
    next();
  } catch (e) {
    next(e);
  }
}

/**
 * Dashboard requests that change data must be JSON (or a file upload). A cross-site form can't send
 * either without a CORS preflight, which only the addresses in APP_ORIGIN pass; together with
 * SameSite=Lax cookies this blocks cross-site request forgery. COOKIE_DOMAIN doesn't change this:
 * it decides which of our hosts receive the cookie, not which pages may call the API with it.
 */
export function requireJsonForWrites(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const type = req.headers["content-type"] || "";
  if (type.startsWith("application/json") || type.startsWith("multipart/form-data")) return next();
  if (!req.headers["content-length"] || req.headers["content-length"] === "0") return next();
  return res.status(415).json({ message: "Send JSON." });
}
