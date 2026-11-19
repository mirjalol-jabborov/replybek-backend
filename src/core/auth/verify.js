// Confirming the email address of an account made with a password. The email carries a 6-digit
// code (typed into the app, signed in) and a link (one click, on any browser, which signs in).
// Like password resets, both are random, sent only by email, stored as hashes, work once and
// expire; a new email replaces the open one. Google, an emailed invitation and a password reset
// confirm the address too (markVerified).
import crypto from "crypto";
import { query, tx } from "../db.js";
import { HttpError } from "../http.js";
import { sendVerification } from "../emails.js";

const MINUTES = 30; // a code and its link work this long
const TRIES = 5; // wrong codes before the code is dead
const WAIT = 60; // seconds between two emails
const PER_HOUR = 6; // emails in an hour, whatever the wait between them

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
// A 6-digit code is short, so its hash is tied to the person: the same code hashes apart for two people.
const codeHash = (userId, code) => sha(`${userId}:${code}`);
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = (status, code, message, extra) => new HttpError(status, message, { code, ...extra });
const sameEmail = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** Marks the address confirmed, inside the caller's transaction (`c`); an open code and link stop working. */
export async function markVerified(c, userId) {
  await c.query("UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1", [userId]);
  await c.query("UPDATE email_verifications SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [userId]);
}

// Seconds until the next email may go: the wait after the last one, and the hourly cap.
const WAITS = `GREATEST(0, ceil(extract(epoch FROM sent_at + make_interval(secs => ${WAIT}) - now())))::int AS next_in,
  CASE WHEN sends >= ${PER_HOUR} AND sends_since > now() - interval '1 hour'
       THEN ceil(extract(epoch FROM sends_since + interval '1 hour' - now()))::int ELSE 0 END AS hour_in`;

/**
 * Makes a new code and link for `email`, replacing the open ones, unless one went out too
 * recently (429 resend_wait with retry_in). A changed address skips the minute's wait (a typo is
 * fixed right after signing up) but not the hourly cap. Returns { code, token } to email.
 */
async function issue(c, userId, email, changed) {
  const open = (await c.query(`SELECT ${WAITS} FROM email_verifications WHERE user_id = $1 FOR UPDATE`, [userId])).rows[0];
  const wait = open ? Math.max(open.hour_in, changed ? 0 : open.next_in) : 0;
  if (wait > 0) throw fail(429, "resend_wait", `You can send a new code in ${wait} seconds.`, { retry_in: wait });
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const token = crypto.randomBytes(32).toString("base64url");
  await c.query(
    `INSERT INTO email_verifications (user_id, email, code_hash, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => ${MINUTES}))
     ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, code_hash = EXCLUDED.code_hash, token_hash = EXCLUDED.token_hash,
       tries = 0, used_at = NULL, sent_at = now(), expires_at = EXCLUDED.expires_at,
       sends = CASE WHEN email_verifications.sends_since <= now() - interval '1 hour' THEN 1 ELSE email_verifications.sends + 1 END,
       sends_since = CASE WHEN email_verifications.sends_since <= now() - interval '1 hour' THEN now() ELSE email_verifications.sends_since END`,
    [userId, email, codeHash(userId, code), sha(token)]
  );
  return { code, token };
}

/** What the "Check your email" screen shows: where the code went and when a new one can be sent. */
export async function pendingFor(user) {
  const { rows } = await query(`SELECT ${WAITS} FROM email_verifications WHERE user_id = $1`, [user.id]);
  return { email: user.email, resend_in: rows[0] ? Math.max(rows[0].next_in, rows[0].hour_in) : 0 };
}

/**
 * Emails a new code and link to the person's address. `origin` is the app the link opens (one of
 * APP_ORIGIN), `lang` the email's language.
 */
export async function sendCode(user, { lang, origin }) {
  if (user.email_verified) throw fail(409, "already_verified", "Your email is already confirmed.");
  const { code, token } = await tx((c) => issue(c, user.id, user.email, false));
  await sendVerification({ to: user.email, lang, code, token, origin });
  return { email: user.email, resend_in: WAIT };
}

/** Fixes a typo in an unconfirmed address: the account takes the new one and a new code goes there. */
export async function changeEmail(user, email, { lang, origin }) {
  if (user.email_verified) throw fail(409, "already_verified", "Your email is already confirmed.");
  if (sameEmail(user.email, email)) return sendCode(user, { lang, origin });
  let issued;
  try {
    issued = await tx(async (c) => {
      const taken = await c.query("SELECT 1 FROM users WHERE email = $1 AND id <> $2", [email, user.id]);
      // The same answer as signing up with that address.
      if (taken.rows[0]) throw fail(409, "email_taken", "An account with this email already exists. Sign in instead.");
      const next = await issue(c, user.id, email, true);
      await c.query("UPDATE users SET email = $2 WHERE id = $1", [user.id, email]);
      return next;
    });
  } catch (e) {
    if (e.code === "23505") throw fail(409, "email_taken", "An account with this email already exists. Sign in instead.");
    throw e;
  }
  await sendVerification({ to: email, lang, ...issued, origin });
  return { email, resend_in: WAIT };
}

/** The signed-in person types the code. Wrong codes count; after TRIES the code is dead. */
export async function confirmCode(user, typed) {
  if (user.email_verified) return;
  const code = String(typed ?? "").replace(/\s+/g, "");
  // Decided inside the transaction, thrown after it, so a wrong try is still counted.
  const outcome = await tx(async (c) => {
    const row = (await c.query("SELECT *, expires_at <= now() AS expired FROM email_verifications WHERE user_id = $1 FOR UPDATE", [user.id])).rows[0];
    if (!row || row.used_at || !sameEmail(row.email, user.email)) return "expired";
    if (row.tries >= TRIES) return "dead";
    if (row.expired) return "expired";
    if (!/^\d{6}$/.test(code) || !same(row.code_hash, codeHash(user.id, code))) {
      await c.query("UPDATE email_verifications SET tries = tries + 1 WHERE user_id = $1", [user.id]);
      return row.tries + 1 >= TRIES ? "dead" : TRIES - row.tries - 1;
    }
    await markVerified(c, user.id);
    return "ok";
  });
  if (outcome === "ok") return;
  if (outcome === "dead") throw fail(400, "code_dead", "Too many wrong codes. Send a new code.");
  if (outcome === "expired") throw fail(400, "code_expired", "This code has expired. Send a new code.");
  throw fail(400, "code_wrong", "That code isn't right. Check the email and try again.", { tries_left: outcome });
}

/** The link from the email: confirms the address and returns whose it is, to sign them in. */
export async function confirmLink(token) {
  const invalid = () => fail(400, "link_invalid", "This confirmation link isn't valid. Sign in to get a new code.");
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw invalid();
  return tx(async (c) => {
    const { rows } = await c.query(
      `SELECT v.*, v.expires_at <= now() AS expired, u.email AS current FROM email_verifications v JOIN users u ON u.id = v.user_id
        WHERE v.token_hash = $1 FOR UPDATE OF v`,
      [sha(token)]
    );
    const row = rows[0];
    if (!row || !sameEmail(row.email, row.current)) throw invalid();
    if (row.used_at) throw fail(400, "link_used", "This link was already used. Sign in to continue.");
    if (row.tries >= TRIES || row.expired) throw fail(400, "link_expired", "This link has expired. Sign in to get a new code.");
    await markVerified(c, row.user_id);
    return row.user_id;
  });
}
