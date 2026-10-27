import { query, tx } from "../db.js";
import { notFound, HttpError } from "../lib/http.js";
import { summarize } from "./answer.service.js";
import { logActivity } from "./activity.service.js";
import { ATTACHMENTS_SQL, checkFile, storeAttachment } from "./attachments.service.js";
import { signal } from "./events.service.js";

const VIEWS = {
  all: "TRUE",
  needs_human: "c.status = 'needs_human'",
  ai: "c.status = 'ai'",
  mine: "c.assignee_id = $2 AND c.status <> 'resolved'",
  resolved: "c.status = 'resolved'",
};

export async function listConversations(workspaceId, userId, { view = "all", agent, q } = {}) {
  const where = [`c.workspace_id = $1`, VIEWS[view] || "TRUE"];
  // Only the "mine" view uses the user id ($2); Postgres rejects unused parameters.
  const params = view === "mine" ? [workspaceId, userId] : [workspaceId];
  if (agent) {
    params.push(agent);
    where.push(`c.agent_id = $${params.length}`);
  }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where.push(`(lower(coalesce(c.visitor->>'name', '')) LIKE $${params.length} OR lower(coalesce(c.subject, '')) LIKE $${params.length}
      OR lower(coalesce(c.visitor->>'email', '')) LIKE $${params.length} OR lower(coalesce(c.visitor->>'user_id', '')) LIKE $${params.length}
      OR lower(coalesce(c.visitor->'company'->>'name', '')) LIKE $${params.length}
      OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.role <> 'note' AND lower(m.body) LIKE $${params.length}))`);
  }
  const { rows } = await query(
    `SELECT c.id, c.agent_id, c.status, c.assignee_id, c.visitor - 'avatar' - 'attributes' AS visitor, (c.visitor ? 'avatar') AS has_avatar,
            c.subject, c.unread, c.created_at, c.last_message_at,
            c.visitor_seen_at, c.left_at, c.continued_in, now() AS server_now,
            (SELECT json_build_object('role', m.role, 'body', m.body, 'author_id', m.author_id,
                    'files', (SELECT count(*) FROM attachments a WHERE a.message_id = m.id)) FROM messages m
              WHERE m.conversation_id = c.id AND m.role NOT IN ('system', 'note') ORDER BY m.seq DESC LIMIT 1) AS last_message
       FROM conversations c WHERE ${where.join(" AND ")}
      ORDER BY c.last_message_at DESC LIMIT 200`,
    params
  );
  return rows;
}

async function load(workspaceId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Conversation not found");
  const { rows } = await query("SELECT * FROM conversations WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
  if (!rows[0]) throw notFound("Conversation not found");
  return rows[0];
}

const messagesOf = async (id) =>
  (await query(`SELECT m.id, m.role, m.author_id, m.body, m.kind, m.sources, m.created_at, ${ATTACHMENTS_SQL} FROM messages m WHERE m.conversation_id = $1 ORDER BY m.seq`, [id])).rows;

export async function getConversation(workspaceId, id, { markRead = true } = {}) {
  const c = await load(workspaceId, id);
  if (markRead && c.unread) await query("UPDATE conversations SET unread = false WHERE id = $1", [id]);
  const { visitor_token_hash, ...rest } = c;
  // server_now: the clock "seen 20 s ago" is measured against, whatever the viewer's clock says.
  return { ...rest, unread: markRead ? false : c.unread, server_now: new Date().toISOString(), messages: await messagesOf(id) };
}

/**
 * The visitor's photo, as the page sent it: an image this API serves, or a redirect to an https
 * link. Lists fetch it here instead of carrying every photo in every list.
 */
export async function visitorAvatar(workspaceId, id, res) {
  const c = await load(workspaceId, id);
  const avatar = c.visitor?.avatar;
  if (!avatar) throw notFound("No photo");
  res.set("Cache-Control", "private, max-age=300");
  if (avatar.startsWith("https://")) return res.redirect(302, avatar);
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(avatar);
  if (!m) throw notFound("No photo");
  res.set({ "Content-Type": m[1], "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" });
  res.end(Buffer.from(m[2], "base64"));
}

/** A teammate is writing a reply: the visitor's chat shows "<name> is typing" for a few seconds. */
export async function teamTyping(workspaceId, id, user) {
  const c = await load(workspaceId, id);
  if (c.status !== "human" || c.assignee_id !== user.id) return { ok: false };
  await signal(`c:${c.id}`, "typing", { who: "team", name: String(user.name || "").split(/\s+/)[0] });
  return { ok: true };
}

/** Adds a message and returns its id. */
export async function addMessage(db, conv, { role, body, author_id = null, kind = null, sources = null, card = null, unread }) {
  const { rows } = await db.query(
    "INSERT INTO messages (conversation_id, workspace_id, role, author_id, body, kind, sources, card) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
    [conv.id, conv.workspace_id, role, author_id, body, kind, sources ? JSON.stringify(sources) : null, card]
  );
  await db.query(`UPDATE conversations SET last_message_at = now()${unread === undefined ? "" : ", unread = " + (unread ? "true" : "false")} WHERE id = $1`, [conv.id]);
  return rows[0].id;
}

/** Adds a message with an optional file in one transaction, so nobody sees one without the other. */
export async function addMessageWithFile(conv, message, file) {
  const checked = file ? checkFile(file) : null;
  return tx(async (c) => {
    const id = await addMessage(c, conv, message);
    if (file) await storeAttachment(c, conv, id, file, checked);
    return id;
  });
}

const event = (db, conv, text) => addMessage(db, conv, { role: "system", body: text });

export async function takeOver(workspaceId, id, user) {
  const conv = await load(workspaceId, id);
  if (conv.status === "resolved") throw new HttpError(409, "Reopen the conversation before taking over.");
  const summary = conv.status === "human" && conv.assignee_id === user.id ? conv.summary : await summarize(await messagesOf(id));
  await tx(async (c) => {
    await c.query("UPDATE conversations SET status = 'human', assignee_id = $2, summary = COALESCE($3, summary), escalated_at = COALESCE(escalated_at, now()) WHERE id = $1", [id, user.id, summary]);
    await event(c, conv, `${user.name} took over · AI paused`);
  });
  await logActivity(workspaceId, user.id, "{actor} took over a conversation", { actor: user.name }, conv.subject);
  return getConversation(workspaceId, id);
}

export async function handBack(workspaceId, id, user) {
  const conv = await load(workspaceId, id);
  await tx(async (c) => {
    await c.query("UPDATE conversations SET status = 'ai' WHERE id = $1", [id]);
    await event(c, conv, `${user.name} handed the conversation back to AI`);
  });
  return getConversation(workspaceId, id);
}

export async function reply(workspaceId, id, user, text, file = null) {
  const conv = await load(workspaceId, id);
  if (conv.status !== "human" || conv.assignee_id !== user.id) throw new HttpError(409, "Take over the conversation before replying.");
  if (!text && !file) throw new HttpError(400, "Write a reply or attach a file.");
  await addMessageWithFile(conv, { role: "human", body: text, author_id: user.id }, file);
  return getConversation(workspaceId, id);
}

export async function addNote(workspaceId, id, user, text, file = null) {
  const conv = await load(workspaceId, id);
  if (!text && !file) throw new HttpError(400, "Write a note or attach a file.");
  await addMessageWithFile(conv, { role: "note", body: text, author_id: user.id }, file);
  return getConversation(workspaceId, id);
}

export async function assign(workspaceId, id, actor, userId) {
  const conv = await load(workspaceId, id);
  let name = null;
  if (userId) {
    const { rows } = await query("SELECT u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.user_id = $2", [workspaceId, userId]);
    if (!rows[0]) throw new HttpError(400, "That person isn't in this workspace.");
    name = rows[0].name;
  }
  await tx(async (c) => {
    // Assigning someone else while a teammate is replying moves the reply duty to them.
    await c.query("UPDATE conversations SET assignee_id = $2 WHERE id = $1", [id, userId]);
    await event(c, conv, name ? `Assigned to ${name}` : "Unassigned");
  });
  if (name) await logActivity(workspaceId, actor.id, conv.subject ? "{name} was assigned “{subject}”" : "{name} was assigned a conversation", { name, subject: conv.subject });
  return getConversation(workspaceId, id);
}

export async function resolve(workspaceId, id, user) {
  const conv = await load(workspaceId, id);
  await tx(async (c) => {
    await c.query("UPDATE conversations SET status = 'resolved', resolved_by = $2 WHERE id = $1", [id, user.name]);
    await event(c, conv, `Marked resolved by ${user.name}`);
  });
  return getConversation(workspaceId, id);
}

export async function reopen(workspaceId, id, user) {
  const conv = await load(workspaceId, id);
  await tx(async (c) => {
    await c.query("UPDATE conversations SET status = CASE WHEN assignee_id IS NULL THEN 'needs_human' ELSE 'human' END, resolved_by = NULL WHERE id = $1", [id]);
    await event(c, conv, `Reopened by ${user.name}`);
  });
  return getConversation(workspaceId, id);
}

export async function markUnread(workspaceId, id) {
  await load(workspaceId, id);
  await query("UPDATE conversations SET unread = true WHERE id = $1", [id]);
}
