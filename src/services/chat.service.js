import { query, tx } from "../db.js";
import { answerQuestion, describeOutcome } from "./answer.service.js";
import { decideAction, disconnect, actionIntegrationMode, agentHasInPageTools } from "./integrations.service.js";
import { addMessage, addMessageWithFile } from "./conversations.service.js";
import { ATTACHMENTS_SQL, checkFile, readForAI, saveReading, fileContext, filesForAI } from "./attachments.service.js";
import { assertCanAnswer } from "./workspaces.service.js";
import { notifyWaiting } from "./notify.service.js";
import { logActivity } from "./activity.service.js";
import { deliver, settleCard } from "./delivery.service.js";

/**
 * One conversation, whatever it arrives on. The widget and every messaging channel share this:
 * the customer's message goes in, the agent answers from the same knowledge with the same tools,
 * and a change still waits for the customer's Confirm. Channels own only their transport,
 * their identity and how they draw a card.
 */

// Customers see their own messages, the AI's and teammates'. Never internal notes or system events.
const VISIBLE = ["visitor", "ai", "human"];
/** Whether a live-update event (events.service.js) is about something the customer can see. */
export const visitorSees = (e) => e.t !== "messages" || VISIBLE.includes(e.r);

// Emailing the team never holds up or breaks the chat.
const tellTeam = (conv) => notifyWaiting(conv).catch((e) => console.error(`Handoff email failed: ${e.message}`));

export async function visibleMessages(convId, after) {
  const { rows } = await query(
    `SELECT m.id, m.role, m.body, m.kind, m.sources, m.card, m.created_at, ${ATTACHMENTS_SQL} FROM messages m
      WHERE m.conversation_id = $1 AND m.role = ANY($2) AND ($3::timestamptz IS NULL OR m.created_at > $3)
      ORDER BY m.seq`,
    [convId, VISIBLE, after || null]
  );
  return rows;
}

/** Messages as the AI sees them: teammates' replies left out, files as what the AI read from them. */
export async function forAI(conversationId, messages, max = 1500) {
  const files = messages.some((m) => m.attachments?.length) ? await filesForAI(conversationId) : new Map();
  const note = (f) => f && fileContext(f, f.text, max);
  return messages.filter((m) => m.role !== "human").map((m) => ({ role: m.role, body: [m.body, note(files.get(m.id))].filter(Boolean).join("\n") }));
}

/** Adds a message the customer is meant to read, and hands it to the channel that will carry it. */
export async function say(conv, message, delivery = {}) {
  const id = await addMessage({ query }, conv, message);
  await deliver(conv, { id, ...message }, delivery);
  return id;
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
    return await answerQuestion({ agent, question: ask.text, file, history, conversationId: conv.id, inpageOrigin, channel: conv.channel, pageLanguage: ask.language });
  } catch (e) {
    // 402: the free trial ended unpaid. The customer still gets the team, just not the AI.
    if (e.status !== 402) console.error(`Answer failed for agent ${agent.id}:`, e.message);
    return agent.handoff
      ? { kind: "handoff", text: "Sorry, I can't answer right now. I've passed your message to the team, who will reply here.", sources: [] }
      : { kind: "fallback", text: "Sorry, I can't answer right now. Please try again in a few minutes.", sources: [] };
  }
}

/** Saves an answer message and moves the conversation to the team on a handoff. */
async function persistAnswer(agent, conv, res, text) {
  let next = conv;
  let messageId;
  const message = { role: "ai", body: res.text, kind: res.kind, sources: res.sources, card: res.card || null };
  await tx(async (c) => {
    messageId = await addMessage(c, conv, message);
    if (res.kind === "handoff") {
      await c.query("UPDATE conversations SET status = 'needs_human', unread = true, escalated_at = COALESCE(escalated_at, now()) WHERE id = $1", [conv.id]);
      await addMessage(c, conv, { role: "system", body: "AI handed off to the team" });
      next = { ...conv, status: "needs_human" };
    }
  });
  await deliver(conv, { id: messageId, ...message });
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

/**
 * A customer's message, with an optional file. The AI answers only while it's handling the
 * conversation. Returns the conversation as it now stands, the messages that existed before this
 * one (so a caller can show only what is new) and whether the answer is still being written.
 * `answer: false` keeps the message (and reads its file) without answering: one of several sent in a
 * row, which the answer to the last of them takes in.
 */
export async function receiveMessage(agent, conv, { text, file }, { inpageOrigin = null, language = null, answer = true } = {}) {
  const checked = file ? checkFile(file) : null;
  const seen = await visibleMessages(conv.id);
  const history = await forAI(conv.id, seen);
  const firstMessage = !history.some((m) => m.role === "visitor");

  if (conv.status === "resolved") {
    await query("UPDATE conversations SET status = 'ai', resolved_by = NULL WHERE id = $1", [conv.id]);
    conv = { ...conv, status: "ai" };
  }
  const messageId = await addMessageWithFile(conv, { role: "visitor", body: text, unread: conv.status !== "ai" }, file);
  await query("UPDATE conversations SET visitor_seen_at = now() WHERE id = $1", [conv.id]);
  // The page's language, kept for later answers in this chat (after a sign-in or a confirmed change).
  if (language && language !== conv.visitor?.language) {
    await query("UPDATE conversations SET visitor = visitor || jsonb_build_object('language', $2::text) WHERE id = $1", [conv.id, language]);
  }
  const subject = text || checked?.name || "";
  if (firstMessage) {
    await query("UPDATE conversations SET subject = $2 WHERE id = $1", [conv.id, subject.length > 70 ? subject.slice(0, 67) + "…" : subject]);
  }
  if (conv.status !== "ai") return { conv, seen, thinking: false };
  if (!answer) {
    if (checked) await readNewFile(agent, messageId, file.buffer, checked).catch((e) => console.error(`Could not read a file on conversation ${conv.id}:`, e.message));
    return { conv, seen, thinking: false };
  }

  // The AI reads the file just before answering (a photo takes one model call). With the team
  // handling the chat it isn't read; later answers then just know a file came.
  const ask = { text, language, file: checked ? () => readNewFile(agent, messageId, file.buffer, checked) : null };
  // With in-page tools the answer runs tool calls in the customer's browser, so it can't finish
  // inside this request (the browser is waiting on it). Answer in the background; the widget polls.
  if (conv.channel === "widget" && (await agentHasInPageTools(agent.id))) {
    answerInBackground(agent, conv, ask, history, inpageOrigin);
    return { conv, seen, thinking: true };
  }
  const res = await runAnswer(agent, conv, ask, history, inpageOrigin);
  return { conv: await persistAnswer(agent, conv, res, text || checked.name), seen, thinking: false };
}

/** The conversation goes to a person: the AI stops answering until a teammate hands it back. */
export async function handToTeam(agent, conv, why) {
  await tx(async (c) => {
    await c.query("UPDATE conversations SET status = 'needs_human', unread = true, escalated_at = COALESCE(escalated_at, now()) WHERE id = $1", [conv.id]);
    await addMessage(c, conv, { role: "system", body: why });
  });
  await logActivity(agent.workspace_id, null, why, {}, conv.subject);
  tellTeam(conv);
}

/** The customer pressed Confirm or Cancel on a change the AI proposed. */
export async function decide(agent, conv, actionId, confirm, { inpageOrigin = null } = {}) {
  if (confirm && (await actionIntegrationMode(conv.id, actionId)) === "in_page") {
    decideInBackground(agent, conv, actionId, inpageOrigin);
    return { thinking: true };
  }
  await applyDecision(agent, conv, actionId, confirm, inpageOrigin);
  return { thinking: false };
}

/** Runs the decision, tells the customer what happened, and continues a multi-step procedure. */
export async function applyDecision(agent, conv, actionId, confirm, inpageOrigin = null) {
  const seen = await visibleMessages(conv.id);
  const outcome = await decideAction(conv.id, actionId, confirm, inpageOrigin);
  await query("UPDATE messages SET card = jsonb_set(card, '{status}', to_jsonb($3::text)) WHERE conversation_id = $1 AND card->>'action_id' = $2", [conv.id, actionId, outcome.status]);
  await settleCard(conv, actionId, outcome.status);
  const text = await describeOutcome({ agent, history: await forAI(conv.id, seen.slice(-6), 600), outcome, pageLanguage: conv.visitor?.language });
  await say(conv, { role: "ai", body: text, kind: "answer" });
  if (outcome.continuation) {
    const next = outcome.continuation;
    const body = next.card ? "Please review the next step before continuing." : next.output?.error ? next.output.message || "The procedure stopped." : next.output?.status === "completed" ? "The procedure is complete." : "The procedure stopped.";
    await say(conv, { role: "ai", body, kind: "answer", card: next.card || null });
  }
  if (outcome.status === "failed" && /sign in/i.test(outcome.error || "")) await disconnect(conv.id, outcome.integration_id);
  return { seen, outcome };
}

async function decideInBackground(agent, conv, actionId, inpageOrigin) {
  try {
    await applyDecision(agent, conv, actionId, true, inpageOrigin);
  } catch (e) {
    console.error(`Background confirm failed for conversation ${conv.id}:`, e.message);
  }
}
