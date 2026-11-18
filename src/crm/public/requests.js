// What customers made on a public page (crm_public_requests): the short reference they quote and
// the secret token that lets them look at it. The token is shown once, when the booking or order
// is made; only its hash is kept, and it is compared in constant time.
import crypto from "node:crypto";
import { HttpError } from "../../core/http.js";
import { pageNotFound } from "./pages.js";

// No 0/O, 1/I/L: a reference is read out on the phone.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const REF = /^[A-HJKMNP-Z2-9]{8}$/;
const newRef = () => Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join("");
const newToken = () => crypto.randomBytes(24).toString("base64url");
const hashOf = (token) => crypto.createHash("sha256").update(String(token)).digest();
const BLANK = hashOf("");

/**
 * Keeps a new booking or order made on the page: { ref, token }. item: { appointmentId } or { orderId }.
 * A reference is random; the rare one already taken in the workspace is drawn again.
 */
export async function recordRequest(q, cfg, kind, item) {
  const token = newToken();
  for (let i = 0; i < 5; i++) {
    const ref = newRef();
    const { rows } = await q(
      `INSERT INTO crm_public_requests (workspace_id, ref, kind, appointment_id, order_id, token_hash)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING ref`,
      [cfg.workspaceId, ref, kind, item.appointmentId || null, item.orderId || null, hashOf(token)]
    );
    if (rows[0]) return { ref, token };
  }
  throw new HttpError(503, "Try again.", { code: "try_again" });
}

/** A made-up answer for a request the honeypot caught: it looks like the real one and saves nothing. */
export const decoy = () => ({ ref: newRef(), token: newToken() });

/**
 * The request behind a reference, when the token is its own: { ref, kind, appointmentId, orderId }.
 * Any other case, a wrong token, a missing one or another kind, is the same 404.
 * `lock`: "FOR UPDATE" inside a write.
 */
export async function findRequest(q, cfg, kind, ref, token, lock = "") {
  const key = String(ref || "").toUpperCase();
  const row = REF.test(key)
    ? (await q(`SELECT ref, kind, appointment_id AS "appointmentId", order_id AS "orderId", token_hash FROM crm_public_requests WHERE workspace_id = $1 AND ref = $2 ${lock}`, [cfg.workspaceId, key])).rows[0]
    : null;
  // The comparison runs whether or not the reference exists, so the time it takes tells nothing.
  const given = typeof token === "string" && token.length <= 100 ? hashOf(token) : BLANK;
  const same = crypto.timingSafeEqual(given, row ? row.token_hash : BLANK) && Boolean(row);
  if (!same || row.kind !== kind) throw pageNotFound();
  const { token_hash, ...out } = row;
  return out;
}
