import bcrypt from "bcrypt";
import { query, tx } from "../db.js";
import { HttpError } from "../http.js";
import { markVerified } from "./verify.js";

/** A person as the apps see them; `email_verified` says whether the address is confirmed. */
export const USER = "id, name, email, avatar, (email_verified_at IS NOT NULL) AS email_verified";

export async function userById(id) {
  return (await query(`SELECT ${USER} FROM users WHERE id = $1`, [id])).rows[0];
}

/** A new account made with a password starts unconfirmed: the routes email it a code (verify.js). */

export async function register({ name, email, password, workspace_name, website, product = "agent" }) {
  const exists = await query("SELECT 1 FROM users WHERE email = $1", [email]);
  if (exists.rows[0]) throw new HttpError(409, "An account with this email already exists. Sign in instead.");
  const passwordHash = await bcrypt.hash(password, 12);
  return tx(async (c) => {
    const user = (await c.query(`INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING ${USER}`, [name, email, passwordHash])).rows[0];
    // The workspace starts with the product the person signed up for; the other can be added later.
    const workspace = (await c.query("INSERT INTO workspaces (name, website, products) VALUES ($1, $2, $3) RETURNING *", [workspace_name, website || null, [product]])).rows[0];
    await c.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [workspace.id, user.id]);
    return { user, workspace };
  });
}

// Compared against when the email is unknown, so both cases take the same time.
let dummyHash;
const DUMMY_HASH = () => (dummyHash ||= bcrypt.hashSync("not-a-real-password", 12));

export async function login({ email, password }) {
  const { rows } = await query(`SELECT ${USER}, password_hash FROM users WHERE email = $1`, [email]);
  const ok = await bcrypt.compare(password, rows[0]?.password_hash || DUMMY_HASH());
  if (!rows[0] || !ok) throw new HttpError(401, "Wrong email or password.");
  const { password_hash, ...user } = rows[0];
  return user;
}

// Webmail domains don't name a business, so a workspace made from one is named after the person.
const WEBMAIL = /^(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|icloud|me|mail|yandex|proton|protonmail|inbox|bk|list|rambler)\./i;

/**
 * Signs in with a verified Google account: by its Google id, else by the same email (which links
 * the two), else a new account with its own workspace. A new workspace is named provisionally;
 * onboarding renames it after the business's website. `product`: what a new workspace is for.
 * Google has checked the address, so the account counts as confirmed. An unconfirmed password
 * account for it was made by someone who never proved the address was theirs: its password and
 * sessions end, so only the address's owner keeps it.
 */
export async function googleSignIn({ sub, email, emailVerified, name }, product = "agent") {
  if (!email || !emailVerified) throw new HttpError(403, "Your Google account's email isn't verified.");
  const known = await query(`SELECT ${USER}, google_sub FROM users WHERE google_sub = $1 OR email = $2 ORDER BY (google_sub = $1) DESC NULLS LAST LIMIT 1`, [sub, email]);
  if (known.rows[0]) {
    const u = known.rows[0];
    if (u.google_sub && u.google_sub !== sub) throw new HttpError(409, "This email is linked to a different Google account.");
    await tx(async (c) => {
      if (!u.google_sub) await c.query("UPDATE users SET google_sub = $2 WHERE id = $1", [u.id, sub]);
      if (!u.email_verified && u.email.toLowerCase() === email.toLowerCase()) {
        await c.query("UPDATE users SET password_hash = NULL WHERE id = $1", [u.id]);
        await c.query("DELETE FROM sessions WHERE user_id = $1", [u.id]);
        await markVerified(c, u.id);
      }
    });
    return { user: await userById(u.id), created: false };
  }
  const domain = email.split("@")[1] || "";
  const label = domain.split(".")[0];
  const workspaceName = (!WEBMAIL.test(domain) && label ? label.charAt(0).toUpperCase() + label.slice(1) : name || email.split("@")[0]).slice(0, 120);
  return tx(async (c) => {
    const user = (await c.query(`INSERT INTO users (name, email, google_sub, email_verified_at) VALUES ($1, $2, $3, now()) RETURNING ${USER}`, [(name || email.split("@")[0]).slice(0, 120), email, sub])).rows[0];
    const workspace = (await c.query(`INSERT INTO workspaces (name, settings, products) VALUES ($1, '{"auto_named": true}', $2) RETURNING *`, [workspaceName, [product]])).rows[0];
    await c.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [workspace.id, user.id]);
    return { user, created: true };
  });
}

/** Changes your own name or photo ("" removes the photo). */
export async function updateProfile(userId, { name, avatar }) {
  const { rows } = await query(
    `UPDATE users SET name = COALESCE($2, name), avatar = CASE WHEN $3::text IS NULL THEN avatar ELSE NULLIF($3, '') END WHERE id = $1 RETURNING ${USER}`,
    [userId, name ?? null, avatar ?? null]
  );
  return rows[0];
}

export async function workspacesOf(userId) {
  const { rows } = await query(
    "SELECT w.id, w.name, w.website, w.plan, w.products, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = $1 ORDER BY m.created_at",
    [userId]
  );
  return rows;
}
