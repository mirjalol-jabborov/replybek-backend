import crypto from "crypto";
import { query, tx } from "../db.js";
import { notFound, HttpError } from "../lib/http.js";
import { answerQuestion, describeOutcome } from "./answer.service.js";
import { connectUrl, decideAction, disconnect, pendingToolCalls, deliverToolResult } from "./integrations.service.js";
import { agentHasInPageTools, actionIntegrationMode } from "./integrations.service.js";
import { addMessage, addMessageWithFile } from "./conversations.service.js";
import { ATTACHMENTS_SQL, checkFile, readForAI, saveReading, fileContext, filesForAI } from "./attachments.service.js";
import { notifyWaiting } from "./notify.service.js";

// Emailing the team never holds up or breaks the chat.
const tellTeam = (conv) => notifyWaiting(conv).catch((e) => console.error(`Handoff email failed: ${e.message}`));
import { logActivity } from "./activity.service.js";
import { savedQuestions } from "./suggestions.service.js";
import { assertCanAnswer } from "./workspaces.service.js";

const hash = (t) => crypto.createHash("sha256").update(t).digest("hex");
// Visitors see their own messages, the AI's and teammates'. Never internal notes or system events.
const VISIBLE = ["visitor", "ai", "human"];
/** Whether a live-update event (events.service.js) is about something the visitor can see. */
export const visitorSees = (e) => e.t !== "messages" || VISIBLE.includes(e.r);

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

export const widgetConfig = (agent, language = "en") => ({
  name: agent.name,
  display_name: agent.widget.display_name || agent.workspace_name,
  welcome: agent.welcome,
  suggestions: savedQuestions(agent, language),
  accent: agent.widget.accent || "#111215",
  logo: agent.widget.logo || null,
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

export async function ownConversation(agent, id, token) {
  if (!/^[0-9a-f-]{36}$/i.test(id || "") || !token) throw notFound("Conversation not found");
  const { rows } = await query("SELECT * FROM conversations WHERE id = $1 AND agent_id = $2 AND visitor_token_hash = $3", [id, agent.id, hash(token)]);
  if (!rows[0]) throw notFound("Conversation not found");
  return rows[0];
}

export async function visibleMessages(convId, after) {
  const { rows } = await query(
    `SELECT m.id, m.role, m.body, m.kind, m.sources, m.card, m.created_at, ${ATTACHMENTS_SQL} FROM messages m
      WHERE m.conversation_id = $1 AND m.role = ANY($2) AND ($3::timestamptz IS NULL OR m.created_at > $3)
      ORDER BY m.seq`,
    [convId, VISIBLE, after || null]
  );
  return rows;
}

const statusFor = (conv) => ({ status: conv.status, waiting_for_team: conv.status === "needs_human" || conv.status === "human" });

/** A visitor's message, with an optional file. The AI answers only while it's handling the conversation. */
export async function postVisitorMessage(agent, convId, token, text, inpageOrigin = null, file = null) {
  if (!text && !file) throw new HttpError(400, "Write a message or attach a file.");
  const checked = file ? checkFile(file) : null;
  let conv = await ownConversation(agent, convId, token);
  const seen = await visibleMessages(conv.id);
  const history = await forAI(conv.id, seen);
  const firstMessage = !history.some((m) => m.role === "visitor");

  if (conv.status === "resolved") {
    await query("UPDATE conversations SET status = 'ai', resolved_by = NULL WHERE id = $1", [conv.id]);
    conv = { ...conv, status: "ai" };
  }
  const messageId = await addMessageWithFile(conv, { role: "visitor", body: text, unread: conv.status !== "ai" }, file);
  const subject = text || checked?.name || "";
  if (firstMessage) await query("UPDATE conversations SET subject = $2 WHERE id = $1", [conv.id, subject.length > 70 ? subject.slice(0, 67) + "…" : subject]);

  if (conv.status === "ai") {
    // The AI reads the file just before answering (a photo takes one model call). With the team
    // handling the chat it isn't read; later answers then just know a file came.
    const ask = { text, file: checked ? () => readNewFile(agent, messageId, file.buffer, checked) : null };
    // With in-page tools the answer runs tool calls in the customer's browser, so it can't finish
    // inside this request (the browser is waiting on it). Answer in the background; the widget polls.
    if (await agentHasInPageTools(agent.id)) {
      answerInBackground(agent, conv, ask, history, inpageOrigin);
      return { ...statusFor(conv), thinking: true, messages: (await visibleMessages(conv.id)).slice(seen.length) };
    }
    const res = await runAnswer(agent, conv, ask, history, inpageOrigin);
    conv = await persistAnswer(agent, conv, res, text || checked.name);
  }
  return { ...statusFor(conv), messages: (await visibleMessages(conv.id)).slice(seen.length) };
}

/** Messages as the AI sees them: teammates' replies left out, files as what the AI read from them. */
async function forAI(conversationId, messages, max = 1500) {
  const files = messages.some((m) => m.attachments?.length) ? await filesForAI(conversationId) : new Map();
  const note = (f) => f && fileContext(f, f.text, max);
  return messages.filter((m) => m.role !== "human").map((m) => ({ role: m.role, body: [m.body, note(files.get(m.id))].filter(Boolean).join("\n") }));
}

/** Reads a file the customer just sent, if the workspace can still get answers, and keeps the reading. */
async function readNewFile(agent, messageId, buffer, checked) {
  const allowed = await assertCanAnswer(agent.workspace_id).then(() => true, () => false);
  const text = allowed ? await readForAI(buffer, checked) : null;
  if (text) await saveReading(messageId, text);
  return { name: checked.name, type: checked.type, text };
}

/** Produces an answer, falling back to a safe message if the AI is unavailable. `ask`: { text, file }. */
async function runAnswer(agent, conv, ask, history, inpageOrigin) {
  try {
    const file = ask.file ? await ask.file() : null;
    return await answerQuestion({ agent, question: ask.text, file, history, conversationId: conv.id, inpageOrigin });
  } catch (e) {
    // 402: the free trial ended unpaid. The visitor still gets the team, just not the AI.
    if (e.status !== 402) console.error(`Widget answer failed for agent ${agent.id}:`, e.message);
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
  if (res.kind === "handoff") {
    await logActivity(agent.workspace_id, null, "A conversation was handed to the team", {}, conv.subject || text.slice(0, 70));
    tellTeam(conv);
  }
  return next;
}

/** Answers out of band (for in-page tools). The widget shows typing and picks up the reply by polling. */
async function answerInBackground(agent, conv, ask, history, inpageOrigin) {
  try {
    const res = await runAnswer(agent, conv, ask, history, inpageOrigin);
    await persistAnswer(agent, conv, res, ask.text || "");
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
    tellTeam(conv);
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
  const history = await forAI(conv.id, seen.slice(0, seen.indexOf(lastQuestion)));
  const file = lastQuestion.attachments?.length ? (await filesForAI(conv.id)).get(lastQuestion.id) || null : null;
  try {
    const res = await answerQuestion({ agent, question: lastQuestion.body, file, history, conversationId: conv.id });
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
  const text = await describeOutcome({ agent, history: await forAI(conv.id, seen.slice(-6), 600), outcome });
  await addMessage({ query }, conv, { role: "ai", body: text, kind: "answer" });
  if (outcome.continuation) {
    const next = outcome.continuation;
    const body = next.card ? "Please review the next step before continuing." : next.output?.error ? next.output.message || "The procedure stopped." : next.output?.status === "completed" ? "The procedure is complete." : "The procedure stopped.";
    await addMessage({ query }, conv, { role: "ai", body, kind: "answer", card: next.card || null });
  }
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
