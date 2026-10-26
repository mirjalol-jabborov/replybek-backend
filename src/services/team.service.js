// Teammates: invitations by email, joining through one, roles and removal; and "forgot password".
// Tokens are random, sent only by email (and shown once to the admin who invited), and stored as
// sha256 hashes, like sessions.
import crypto from "crypto";
import bcrypt from "bcrypt";
import { query, tx } from "../db.js";
import { HttpError, notFound } from "../lib/http.js";
import { PLANS } from "./workspaces.service.js";
import { workspacesOf } from "./auth.service.js";
import { logActivity } from "./activity.service.js";
import { sendInvite, sendReset } from "./emails.service.js";

const hash = (t) => crypto.createHash("sha256").update(t).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("base64url");
const appUrl = (hash) => `${(process.env.APP_ORIGIN || "http://localhost:5173").replace(/\/$/, "")}/#/${hash}`;
const UUID = /^[0-9a-f-]{36}$/i;
const PUBLIC = "id, email, role, created_at, expires_at, (expires_at < now()) AS expired";

// ───── Invitations ─────

export async function listInvites(workspaceId) {
  const { rows } = await query(`SELECT ${PUBLIC} FROM invitations WHERE workspace_id = $1 AND accepted_at IS NULL ORDER BY created_at`, [workspaceId]);
  return rows;
}

/** Seats in use: members plus invitations still waiting (expired ones don't count). */
async function seatsTaken(workspaceId, exceptEmail = null) {
  const { rows } = await query(
    `SELECT (SELECT count(*) FROM memberships WHERE workspace_id = $1)
          + (SELECT count(*) FROM invitations WHERE workspace_id = $1 AND accepted_at IS NULL AND expires_at > now() AND email IS DISTINCT FROM $2::citext) AS n`,
    [workspaceId, exceptEmail]
  );
  return Number(rows[0].n);
}

/** Invites someone by email (or renews their open invitation). Returns the invitation and its link. */
export async function createInvite(workspace, inviter, { email, role }, lang) {
  const member = await query("SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND u.email = $2", [workspace.id, email]);
  if (member.rows[0]) throw new HttpError(409, `${email} is already on the team.`);
  const seats = PLANS[workspace.plan]?.seats ?? PLANS.starter.seats;
  if ((await seatsTaken(workspace.id, email)) >= seats) {
    throw new HttpError(402, `All ${seats} seats on your plan are taken. Upgrade the plan or remove a teammate first.`, { seats });
  }
  const token = newToken();
  const { rows } = await query(
    `INSERT INTO invitations (workspace_id, email, role, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')
     ON CONFLICT (workspace_id, email) WHERE accepted_at IS NULL
     DO UPDATE SET role = EXCLUDED.role, token_hash = EXCLUDED.token_hash, invited_by = EXCLUDED.invited_by, created_at = now(), expires_at = EXCLUDED.expires_at
     RETURNING ${PUBLIC}`,
    [workspace.id, email, role, hash(token), inviter.id]
  );
  const mail = await sendInvite({ to: email, lang, inviter: inviter.name, workspace: workspace.name, role, token });
  await logActivity(workspace.id, inviter.id, "{actor} invited {email}", { actor: inviter.name, email });
  return { ...rows[0], link: appUrl(`invite/${token}`), emailed: mail.sent };
}

/** Sends a fresh link (the old one stops working) and gives the invitation another 7 days. */
export async function resendInvite(workspace, inviter, id, lang) {
  if (!UUID.test(id || "")) throw notFound("Invitation not found");
  const { rows } = await query("SELECT email, role FROM invitations WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL", [id, workspace.id]);
  if (!rows[0]) throw notFound("Invitation not found");
  return createInvite(workspace, inviter, rows[0], lang);
}

export async function revokeInvite(workspaceId, id) {
  if (!UUID.test(id || "")) throw notFound("Invitation not found");
  const { rowCount } = await query("DELETE FROM invitations WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL", [id, workspaceId]);
  if (!rowCount) throw notFound("Invitation not found");
}

async function openInvite(token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) throw notFound("This invitation link isn't valid.");
  const { rows } = await query(
    `SELECT i.*, w.name AS workspace_name, u.name AS inviter_name, (i.expires_at < now()) AS expired
       FROM invitations i JOIN workspaces w ON w.id = i.workspace_id LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.token_hash = $1`,
    [hash(token)]
  );
  const inv = rows[0];
  if (!inv) throw notFound("This invitation link isn't valid. Ask for a new one.");
  if (inv.accepted_at) throw new HttpError(410, "This invitation was already used. Sign in to open the workspace.");
  if (inv.expired) throw new HttpError(410, "This invitation expired. Ask the person who invited you to send a new one.");
  return inv;
}

/** What the invitation page shows before someone accepts. */
export async function inviteInfo(token) {
  const inv = await openInvite(token);
  const account = await query("SELECT 1 FROM users WHERE email = $1", [inv.email]);
  return { workspace: inv.workspace_name, inviter: inv.inviter_name, email: inv.email, role: inv.role, has_account: Boolean(account.rows[0]) };
}

async function join(c, inv, userId) {
  await c.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [inv.workspace_id, userId, inv.role]);
  await c.query("UPDATE invitations SET accepted_at = now() WHERE id = $1", [inv.id]);
}

/** A signed-in person accepts. The invitation is for one address: theirs must match. */
export async function acceptInvite(token, user) {
  const inv = await openInvite(token);
  if (user.email.toLowerCase() !== String(inv.email).toLowerCase()) {
    throw new HttpError(403, `This invitation is for ${inv.email}. Sign in with that address to accept it.`, { email: inv.email });
  }
  await tx((c) => join(c, inv, user.id));
  await logActivity(inv.workspace_id, user.id, "{actor} joined the team", { actor: user.name });
  return { workspace_id: inv.workspace_id, workspaces: await workspacesOf(user.id) };
}

/** Someone without an account joins: the account is created for the invited address. */
export async function joinWithInvite(token, { name, password }) {
  const inv = await openInvite(token);
  const exists = await query("SELECT 1 FROM users WHERE email = $1", [inv.email]);
  if (exists.rows[0]) throw new HttpError(409, "An account with this email already exists. Sign in to accept the invitation.");
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await tx(async (c) => {
    const u = (await c.query("INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email", [name, inv.email, passwordHash])).rows[0];
    await join(c, inv, u.id);
    return u;
  });
  await logActivity(inv.workspace_id, user.id, "{actor} joined the team", { actor: user.name });
  return { user, workspace_id: inv.workspace_id, workspaces: await workspacesOf(user.id) };
}

// ───── Members ─────

async function member(workspaceId, userId) {
  if (!UUID.test(userId || "")) throw notFound("Teammate not found");
  const { rows } = await query("SELECT m.role, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.user_id = $2", [workspaceId, userId]);
  if (!rows[0]) throw notFound("Teammate not found");
  return rows[0];
}

export async function updateMemberRole(workspaceId, actor, userId, role) {
  const m = await member(workspaceId, userId);
  if (m.role === "owner") throw new HttpError(409, "The owner's role can't be changed.");
  if (userId === actor.id) throw new HttpError(409, "You can't change your own role.");
  await query("UPDATE memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userId, role]);
}

export async function removeMember(workspaceId, actor, userId) {
  const m = await member(workspaceId, userId);
  if (m.role === "owner") throw new HttpError(409, "The owner can't be removed.");
  if (userId === actor.id) throw new HttpError(409, "You can't remove yourself.");
  await tx(async (c) => {
    // Their open conversations go back to the queue.
    await c.query("UPDATE conversations SET assignee_id = NULL, status = CASE WHEN status = 'human' THEN 'needs_human' ELSE status END WHERE workspace_id = $1 AND assignee_id = $2", [workspaceId, userId]);
    await c.query("DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userId]);
  });
  await logActivity(workspaceId, actor.id, "{actor} removed {name} from the team", { actor: actor.name, name: m.name });
}

// ───── Forgot password ─────

/** Emails a reset link if the address has an account. Says nothing either way. */
export async function forgotPassword(email, lang) {
  const { rows } = await query("SELECT id, email, lang FROM users WHERE email = $1", [email]);
  if (!rows[0]) return;
  // One live link at a time per person.
  await query("DELETE FROM password_resets WHERE user_id = $1", [rows[0].id]);
  const token = newToken();
  await query("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [hash(token), rows[0].id]);
  await sendReset({ to: rows[0].email, lang: lang || rows[0].lang, token });
}

/** Sets the new password, signs out every other session, and returns the user. */
export async function resetPassword(token, password) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) throw new HttpError(400, "This reset link isn't valid. Ask for a new one.");
  const passwordHash = await bcrypt.hash(password, 12);
  return tx(async (c) => {
    const { rows } = await c.query(
      "UPDATE password_resets SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id",
      [hash(token)]
    );
    if (!rows[0]) throw new HttpError(400, "This reset link expired or was already used. Ask for a new one.");
    const user = (await c.query("UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING id, name, email", [rows[0].user_id, passwordHash])).rows[0];
    await c.query("DELETE FROM sessions WHERE user_id = $1", [user.id]);
    return user;
  });
}
