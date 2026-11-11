import crypto from "crypto";
import { query, tx } from "../db.js";
import { notFound, HttpError } from "../lib/http.js";
import { answerQuestion } from "./answer.service.js";
import { connectUrl, pendingToolCalls, deliverToolResult } from "./integrations.service.js";
import { addMessage } from "./conversations.service.js";
import { filesForAI } from "./attachments.service.js";
import { savedQuestions } from "./suggestions.service.js";
import { signal } from "./events.service.js";
import { visibleMessages, forAI, receiveMessage, decide as decideOnChat, handToTeam, say } from "./chat.service.js";
import { widgetTexts } from "./translations.service.js";

/**
 * The website widget's side of a conversation: the key that identifies the agent, the token that
 * proves a browser owns its chat, and presence. The conversation itself is handled by
 * chat.service.js, which every channel shares.
 */

export { visitorSees, visibleMessages } from "./chat.service.js";

const hash = (t) => crypto.createHash("sha256").update(t).digest("hex");

/** The published agent behind a widget key, checked against the page's origin. */
export async function widgetAgent(publicKey, origin) {
  const { rows } = await query(
    "SELECT a.*, w.name AS workspace_name FROM agents a JOIN workspaces w ON w.id = a.workspace_id WHERE a.public_key = $1 AND a.status = 'active'",
    [publicKey]
  );
  const agent = rows[0];
  if (!agent) throw notFound("This chat isn't available.");
  if (agent.allowed_origins.length && !agent.allowed_origins.includes(origin || "")) {
    throw new HttpError(403, "This chat isn't enabled for this website.");
  }
  return agent;
}

/** The widget's settings for a visitor in `language`, with the greeting and questions translated when needed. */
export async function localizedConfig(agent, language = "en") {
  return { ...widgetConfig(agent, language), ...(await widgetTexts(agent, language)) };
}

export const widgetConfig = (agent, language = "en") => ({
  name: agent.name,
  display_name: agent.widget.display_name || agent.workspace_name,
  welcome: agent.welcome_i18n?.[language] || agent.welcome,
  suggestions: savedQuestions(agent, language),
  accent: agent.widget.accent || "#111215",
  logo: agent.widget.logo || null,
  branding: agent.widget.branding !== false,
  handoff: agent.handoff,
});

/**
 * Starts a conversation. `previous` ({ id, token }) is the chat this visitor left with "Start a new
 * chat": the two are linked, so the team can follow the visitor from one to the other.
 */
export async function startConversation(agent, visitor, previous = null) {
  const token = crypto.randomBytes(24).toString("base64url");
  const before = previous ? await ownConversation(agent, previous.id, previous.token).catch(() => null) : null;
  return tx(async (c) => {
    const { rows } = await c.query(
      "INSERT INTO conversations (workspace_id, agent_id, visitor, visitor_token_hash, unread, visitor_seen_at, previous_id) VALUES ($1, $2, $3, $4, false, now(), $5) RETURNING id",
      [agent.workspace_id, agent.id, visitor, hash(token), before?.id || null]
    );
    if (before) await c.query("UPDATE conversations SET continued_in = $2, left_at = COALESCE(left_at, now()) WHERE id = $1", [before.id, rows[0].id]);
    return { conversation_id: rows[0].id, visitor_token: token };
  });
}

// ───── Is the visitor there? ─────

/** The visitor's chat checks in: they're here. Written at most every 20 s. */
export async function visitorHere(agent, convId, token) {
  const conv = await ownConversation(agent, convId, token);
  await query("UPDATE conversations SET visitor_seen_at = now() WHERE id = $1 AND (visitor_seen_at IS NULL OR visitor_seen_at < now() - interval '20 seconds')", [conv.id]);
  return conv;
}

/** The page says who the visitor is: id, name, email, phone, photo, company and its own fields. */
export async function identifyVisitor(agent, convId, token, who) {
  const conv = await ownConversation(agent, convId, token);
  const fields = Object.fromEntries(Object.entries(who).filter(([, v]) => v !== undefined && v !== ""));
  if (!Object.keys(fields).length) return { ok: true };
  await query("UPDATE conversations SET visitor = COALESCE(visitor, '{}'::jsonb) || $2::jsonb WHERE id = $1", [conv.id, JSON.stringify(fields)]);
  return { ok: true };
}

/** The visitor is typing: the team's open Inbox shows it for a few seconds. */
export async function visitorTyping(agent, convId, token) {
  const conv = await visitorHere(agent, convId, token);
  await signal(`w:${conv.workspace_id}`, "typing", { c: conv.id, who: "visitor" });
  return { ok: true };
}

/** The visitor pressed "Start a new chat": this one is left behind, and the team sees so. */
export async function leaveConversation(agent, convId, token) {
  const conv = await ownConversation(agent, convId, token);
  if (conv.left_at) return { ok: true };
  await tx(async (c) => {
    await c.query("UPDATE conversations SET left_at = now() WHERE id = $1", [conv.id]);
    await addMessage(c, conv, { role: "system", body: "Visitor started a new chat" });
  });
  return { ok: true };
}

export async function ownConversation(agent, id, token) {
  if (!/^[0-9a-f-]{36}$/i.test(id || "") || !token) throw notFound("Conversation not found");
  const { rows } = await query("SELECT * FROM conversations WHERE id = $1 AND agent_id = $2 AND visitor_token_hash = $3", [id, agent.id, hash(token)]);
  if (!rows[0]) throw notFound("Conversation not found");
  return rows[0];
}

const statusFor = (conv) => ({ status: conv.status, waiting_for_team: conv.status === "needs_human" || conv.status === "human" });

/** A visitor's message, with an optional file. The AI answers only while it's handling the conversation. */
export async function postVisitorMessage(agent, convId, token, text, inpageOrigin = null, file = null, language = null) {
  if (!text && !file) throw new HttpError(400, "Write a message or attach a file.");
  const { conv, seen, thinking } = await receiveMessage(agent, await ownConversation(agent, convId, token), { text, file }, { inpageOrigin, language });
  return { ...statusFor(conv), ...(thinking ? { thinking } : {}), messages: (await visibleMessages(conv.id)).slice(seen.length) };
}

export async function pollMessages(agent, convId, token, after) {
  const conv = await ownConversation(agent, convId, token);
  return { ...statusFor(conv), messages: await visibleMessages(conv.id, after), pending: await pendingToolCalls(conv.id) };
}

/** The widget delivers the result of an in-page request it ran. */
export async function deliverTool(agent, convId, token, toolCallId, result) {
  const conv = await ownConversation(agent, convId, token);
  await deliverToolResult(conv.id, toolCallId, result);
  return { ok: true };
}

export async function requestHuman(agent, convId, token) {
  const conv = await ownConversation(agent, convId, token);
  if (!agent.handoff) throw new HttpError(409, "This chat doesn't offer a person right now.");
  if (conv.status === "ai" || conv.status === "resolved") await handToTeam(agent, conv, "Visitor asked for a teammate");
  return { status: "needs_human", waiting_for_team: true };
}

// ───── Integrations: signing in and confirming changes ─────

/** The sign-in page for an integration, for this conversation's customer. */
export async function startConnect(agent, convId, token, integrationId) {
  const conv = await ownConversation(agent, convId, token);
  return connectUrl(agent, conv.id, integrationId);
}

/**
 * After the customer signed in: say so, and answer their last question again now that the
 * account can be read. Runs after the sign-in page has closed, so failures only get logged.
 */
export async function afterConnect(conversationId, label, name) {
  const { rows } = await query("SELECT * FROM conversations WHERE id = $1", [conversationId]);
  const conv = rows[0];
  if (!conv) return;
  const agent = (await query("SELECT a.*, w.name AS workspace_name FROM agents a JOIN workspaces w ON w.id = a.workspace_id WHERE a.id = $1", [conv.agent_id])).rows[0];
  await addMessage({ query }, conv, { role: "system", body: `Customer signed in to ${name}${label ? ` as ${label}` : ""}` });
  if (conv.status !== "ai") return;
  const seen = await visibleMessages(conv.id);
  const lastQuestion = [...seen].reverse().find((m) => m.role === "visitor");
  if (!lastQuestion) return;
  const history = await forAI(conv.id, seen.slice(0, seen.indexOf(lastQuestion)));
  const file = lastQuestion.attachments?.length ? (await filesForAI(conv.id)).get(lastQuestion.id) || null : null;
  try {
    const res = await answerQuestion({ agent, question: lastQuestion.body, file, history, conversationId: conv.id, channel: conv.channel });
    await say(conv, { role: "ai", body: res.text, kind: res.kind, sources: res.sources, card: res.card || null });
  } catch (e) {
    console.error(`Answer after sign-in failed for conversation ${conv.id}:`, e.message);
  }
}

/** The customer pressed Confirm or Cancel on a change the AI proposed. */
export async function decide(agent, convId, token, actionId, confirm, inpageOrigin = null) {
  const conv = await ownConversation(agent, convId, token);
  const seen = await visibleMessages(conv.id);
  const { thinking } = await decideOnChat(agent, conv, actionId, confirm, { inpageOrigin });
  return { ...statusFor(conv), ...(thinking ? { thinking } : {}), messages: thinking ? [] : (await visibleMessages(conv.id)).slice(seen.length) };
}
