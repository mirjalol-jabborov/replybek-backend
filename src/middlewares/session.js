import crypto from "crypto";
import { parse, serialize } from "cookie";
import { query } from "../db.js";
import { HttpError } from "../lib/http.js";

export const COOKIE = "nx_session";
const DAYS = 30;
const hash = (token) => crypto.createHash("sha256").update(token).digest("hex");
const secure = () => process.env.NODE_ENV === "production";

export async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  await query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))", [hash(token), userId, DAYS]);
  res.setHeader("Set-Cookie", serialize(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: secure(), path: "/", maxAge: DAYS * 86400 }));
}

export async function endSession(req, res) {
  const token = parse(req.headers.cookie || "")[COOKIE];
  if (token) await query("DELETE FROM sessions WHERE token_hash = $1", [hash(token)]);
  res.setHeader("Set-Cookie", serialize(COOKIE, "", { httpOnly: true, sameSite: "lax", secure: secure(), path: "/", maxAge: 0 }));
}

/** Requires a signed-in user; loads it into req.user. */
export async function requireUser(req, res, next) {
  try {
    const token = parse(req.headers.cookie || "")[COOKIE];
    if (!token) throw new HttpError(401, "Sign in required");
    const { rows } = await query(
      `SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hash(token)]
    );
    if (!rows[0]) throw new HttpError(401, "Your session expired. Sign in again.");
    req.user = rows[0];
    next();
  } catch (e) {
    next(e);
  }
}

/**
 * Dashboard requests that change data must be JSON (or a file upload). A cross-site form can't send
 * either without a CORS preflight, which only APP_ORIGIN passes; together with SameSite=Lax
 * cookies this blocks cross-site request forgery.
 */
export function requireJsonForWrites(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const type = req.headers["content-type"] || "";
  if (type.startsWith("application/json") || type.startsWith("multipart/form-data")) return next();
  if (!req.headers["content-length"] || req.headers["content-length"] === "0") return next();
  return res.status(415).json({ message: "Send JSON." });
}
