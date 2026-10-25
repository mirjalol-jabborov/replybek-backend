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
  const { rows } = await query("SELECT id, name, email, password_hash FROM users WHERE email = $1", [email]);
  const ok = await bcrypt.compare(password, rows[0]?.password_hash || DUMMY_HASH());
  if (!rows[0] || !ok) throw new HttpError(401, "Wrong email or password.");
  const { password_hash, ...user } = rows[0];
  return user;
}

export async function workspacesOf(userId) {
  const { rows } = await query(
    "SELECT w.id, w.name, w.website, w.plan, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = $1 ORDER BY m.created_at",
    [userId]
  );
  return rows;
}
