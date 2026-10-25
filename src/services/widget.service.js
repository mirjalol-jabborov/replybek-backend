import crypto from "crypto";
import { query, tx } from "../db.js";
import { notFound, HttpError } from "../lib/http.js";
import { answerQuestion, describeOutcome } from "./answer.service.js";
import { connectUrl, decideAction, disconnect, pendingToolCalls, deliverToolResult } from "./integrations.service.js";
import { agentHasInPageTools, actionIntegrationMode } from "./integrations.service.js";
import { addMessage } from "./conversations.service.js";
import { logActivity } from "./activity.service.js";

const hash = (t) => crypto.createHash("sha256").update(t).digest("hex");
// Visitors see their own messages, the AI's and teammates'. Never internal notes or system events.
const VISIBLE = ["visitor", "ai", "human"];

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

export const widgetConfig = (agent) => ({
  name: agent.name,
  display_name: agent.widget.display_name || agent.workspace_name,
  welcome: agent.welcome,
  accent: agent.widget.accent || "#1f3d36",
  branding: agent.widget.branding !== false,
  handoff: agent.handoff,
});

export async function startConversation(agent, visitor) {
  const token = crypto.randomBytes(24).toString("base64url");
  const { rows } = await query(
    "INSERT INTO conversations (workspace_id, agent_id, visitor, visitor_token_hash, unread) VALUES ($1, $2, $3, $4, false) RETURNING id",
    [agent.workspace_id, agent.id, visitor, hash(token)]
  );
  return { conversation_id: rows[0].id, visitor_token: token };
}

async function ownConversation(agent, id, token) {
  if (!/^[0-9a-f-]{36}$/i.test(id || "") || !token) throw notFound("Conversation not found");
  const { rows } = await query("SELECT * FROM conversations WHERE id = $1 AND agent_id = $2 AND visitor_token_hash = $3", [id, agent.id, hash(token)]);
  if (!rows[0]) throw notFound("Conversation not found");
  return rows[0];
}

export async function visibleMessages(convId, after) {
  const { rows } = await query(
    `SELECT id, role, body, kind, sources, card, created_at FROM messages
      WHERE conversation_id = $1 AND role = ANY($2) AND ($3::timestamptz IS NULL OR created_at > $3)
      ORDER BY seq`,
    [convId, VISIBLE, after || null]
  );
  return rows;
}

const statusFor = (conv) => ({ status: conv.status, waiting_for_team: conv.status === "needs_human" || conv.status === "human" });

/** A visitor's message. The AI answers only while it's handling the conversation. */
export async function postVisitorMessage(agent, convId, token, text, inpageOrigin = null) {
  let conv = await ownConversation(agent, convId, token);
  const seen = await visibleMessages(conv.id);
  const history = seen.filter((m) => m.role !== "human").map((m) => ({ role: m.role, body: m.body }));
  const firstMessage = !history.some((m) => m.role === "visitor");

  if (conv.status === "resolved") {
    await query("UPDATE conversations SET status = 'ai', resolved_by = NULL WHERE id = $1", [conv.id]);
    conv = { ...conv, status: "ai" };
  }
  await addMessage({ query }, conv, { role: "visitor", body: text, unread: conv.status !== "ai" });
  if (firstMessage) await query("UPDATE conversations SET subject = $2 WHERE id = $1", [conv.id, text.length > 70 ? text.slice(0, 67) + "…" : text]);

  if (conv.status === "ai") {
    // With in-page tools the answer runs tool calls in the customer's browser, so it can't finish
    // inside this request (the browser is waiting on it). Answer in the background; the widget polls.
    if (await agentHasInPageTools(agent.id)) {
      answerInBackground(agent, conv, text, history, inpageOrigin);
      return { ...statusFor(conv), thinking: true, messages: (await visibleMessages(conv.id)).slice(seen.length) };
    }
    const res = await runAnswer(agent, conv, text, history, inpageOrigin);
    conv = await persistAnswer(agent, conv, res, text);
  }
  return { ...statusFor(conv), messages: (await visibleMessages(conv.id)).slice(seen.length) };
}

/** Produces an answer, falling back to a safe message if the AI is unavailable. */
async function runAnswer(agent, conv, text, history, inpageOrigin) {
  try {
    return await answerQuestion({ agent, question: text, history, conversationId: conv.id, inpageOrigin });
  } catch (e) {
    console.error(`Widget answer failed for agent ${agent.id}:`, e.message);
    return agent.handoff
      ? { kind: "handoff", text: "Sorry, I can't answer right now. I've passed your message to the team, who will reply here.", sources: [] }
      : { kind: "fallback", text: "Sorry, I can't answer right now. Please try again in a few minutes.", sources: [] };
  }
}

/** Saves an answer message and moves the conversation to the team on a handoff. */
async function persistAnswer(agent, conv, res, text) {
  let next = conv;
  await tx(async (c) => {
    await addMessage(c, conv, { role: "ai", body: res.text, kind: res.kind, sources: res.sources, card: res.card || null });
    if (res.kind === "handoff") {
      await c.query("UPDATE conversations SET status = 'needs_human', unread = true, escalated_at = COALESCE(escalated_at, now()) WHERE id = $1", [conv.id]);
      await addMessage(c, conv, { role: "system", body: "AI handed off to the team" });
      next = { ...conv, status: "needs_human" };
    }
  });
  if (res.kind === "handoff") await logActivity(agent.workspace_id, null, "A conversation was handed to the team", {}, conv.subject || text.slice(0, 70));
  return next;
}

/** Answers out of band (for in-page tools). The widget shows typing and picks up the reply by polling. */
async function answerInBackground(agent, conv, text, history, inpageOrigin) {
  try {
    const res = await runAnswer(agent, conv, text, history, inpageOrigin);
    await persistAnswer(agent, conv, res, text);
  } catch (e) {
    console.error(`Background answer failed for conversation ${conv.id}:`, e.message);
  }
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
  if (conv.status === "ai" || conv.status === "resolved") {
    await tx(async (c) => {
      await c.query("UPDATE conversations SET status = 'needs_human', unread = true, escalated_at = COALESCE(escalated_at, now()) WHERE id = $1", [conv.id]);
      await addMessage(c, conv, { role: "system", body: "Visitor asked for a teammate" });
    });
    await logActivity(agent.workspace_id, null, "A visitor asked for a teammate", {}, conv.subject);
  }
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
  const { rows } = await query(
    "SELECT c.*, a.id AS a_id FROM conversations c JOIN agents a ON a.id = c.agent_id WHERE c.id = $1",
    [conversationId]
  );
  const conv = rows[0];
  if (!conv) return;
  const agent = (await query("SELECT a.*, w.name AS workspace_name FROM agents a JOIN workspaces w ON w.id = a.workspace_id WHERE a.id = $1", [conv.agent_id])).rows[0];
  await addMessage({ query }, conv, { role: "system", body: `Customer signed in to ${name}${label ? ` as ${label}` : ""}` });
  if (conv.status !== "ai") return;
  const seen = await visibleMessages(conv.id);
  const lastQuestion = [...seen].reverse().find((m) => m.role === "visitor");
  if (!lastQuestion) return;
  const history = seen.slice(0, seen.indexOf(lastQuestion)).filter((m) => m.role !== "human").map((m) => ({ role: m.role, body: m.body }));
  try {
    const res = await answerQuestion({ agent, question: lastQuestion.body, history, conversationId: conv.id });
    await addMessage({ query }, conv, { role: "ai", body: res.text, kind: res.kind, sources: res.sources, card: res.card || null });
  } catch (e) {
    console.error(`Answer after sign-in failed for conversation ${conv.id}:`, e.message);
  }
}

/** The customer pressed Confirm or Cancel on a change the AI proposed. */
export async function decide(agent, convId, token, actionId, confirm, inpageOrigin = null) {
  const conv = await ownConversation(agent, convId, token);
  if (confirm && (await actionIntegrationMode(conv.id, actionId)) === "in_page") {
    decideInBackground(agent, conv, actionId, inpageOrigin);
    return { ...statusFor(conv), thinking: true, messages: [] };
  }
  return finalizeDecide(agent, conv, actionId, confirm, inpageOrigin);
}

async function finalizeDecide(agent, conv, actionId, confirm, inpageOrigin) {
  const seen = await visibleMessages(conv.id);
  const outcome = await decideAction(conv.id, actionId, confirm, inpageOrigin);
  await query("UPDATE messages SET card = jsonb_set(card, '{status}', to_jsonb($3::text)) WHERE conversation_id = $1 AND card->>'action_id' = $2", [conv.id, actionId, outcome.status]);
  const text = await describeOutcome({ agent, history: seen.slice(-6).map((m) => ({ role: m.role, body: m.body })), outcome });
  await addMessage({ query }, conv, { role: "ai", body: text, kind: "answer" });
  if (outcome.status === "failed" && /sign in/i.test(outcome.error || "")) await disconnect(conv.id, outcome.integration_id);
  return { ...statusFor(conv), messages: (await visibleMessages(conv.id)).slice(seen.length) };
}

async function decideInBackground(agent, conv, actionId, inpageOrigin) {
  try {
    await finalizeDecide(agent, conv, actionId, true, inpageOrigin);
  } catch (e) {
    console.error(`Background confirm failed for conversation ${conv.id}:`, e.message);
  }
}
