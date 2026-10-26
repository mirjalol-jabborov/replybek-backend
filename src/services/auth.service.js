import bcrypt from "bcrypt";
import { query, tx } from "../db.js";
import { HttpError } from "../lib/http.js";

export async function register({ name, email, password, workspace_name, website }) {
  const exists = await query("SELECT 1 FROM users WHERE email = $1", [email]);
  if (exists.rows[0]) throw new HttpError(409, "An account with this email already exists. Sign in instead.");
  const passwordHash = await bcrypt.hash(password, 12);
  return tx(async (c) => {
    const user = (await c.query("INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email", [name, email, passwordHash])).rows[0];
    const workspace = (await c.query("INSERT INTO workspaces (name, website) VALUES ($1, $2) RETURNING *", [workspace_name, website || null])).rows[0];
    await c.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [workspace.id, user.id]);
    return { user, workspace };
  });
}

// Compared against when the email is unknown, so both cases take the same time.
let dummyHash;
const DUMMY_HASH = () => (dummyHash ||= bcrypt.hashSync("not-a-real-password", 12));

export async function login({ email, password }) {
  const { rows } = await query("SELECT id, name, email, avatar, password_hash FROM users WHERE email = $1", [email]);
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
 * onboarding renames it after the business's website.
 */
export async function googleSignIn({ sub, email, emailVerified, name }) {
  if (!email || !emailVerified) throw new HttpError(403, "Your Google account's email isn't verified.");
  const known = await query("SELECT id, name, email, google_sub FROM users WHERE google_sub = $1 OR email = $2 ORDER BY (google_sub = $1) DESC NULLS LAST LIMIT 1", [sub, email]);
  if (known.rows[0]) {
    const u = known.rows[0];
    if (u.google_sub && u.google_sub !== sub) throw new HttpError(409, "This email is linked to a different Google account.");
    if (!u.google_sub) await query("UPDATE users SET google_sub = $2 WHERE id = $1", [u.id, sub]);
    return { user: { id: u.id, name: u.name, email: u.email }, created: false };
  }
  const domain = email.split("@")[1] || "";
  const label = domain.split(".")[0];
  const workspaceName = (!WEBMAIL.test(domain) && label ? label.charAt(0).toUpperCase() + label.slice(1) : name || email.split("@")[0]).slice(0, 120);
  return tx(async (c) => {
    const user = (await c.query("INSERT INTO users (name, email, google_sub) VALUES ($1, $2, $3) RETURNING id, name, email", [(name || email.split("@")[0]).slice(0, 120), email, sub])).rows[0];
    const workspace = (await c.query(`INSERT INTO workspaces (name, settings) VALUES ($1, '{"auto_named": true}') RETURNING *`, [workspaceName])).rows[0];
    await c.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [workspace.id, user.id]);
    return { user, created: true };
  });
}

/** Changes your own name or photo ("" removes the photo). */
export async function updateProfile(userId, { name, avatar }) {
  const { rows } = await query(
    "UPDATE users SET name = COALESCE($2, name), avatar = CASE WHEN $3::text IS NULL THEN avatar ELSE NULLIF($3, '') END WHERE id = $1 RETURNING id, name, email, avatar",
    [userId, name ?? null, avatar ?? null]
  );
  return rows[0];
}

export async function workspacesOf(userId) {
  const { rows } = await query(
    "SELECT w.id, w.name, w.website, w.plan, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = $1 ORDER BY m.created_at",
    [userId]
  );
  return rows;
}
