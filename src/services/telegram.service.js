import crypto from "crypto";
import { query } from "../db.js";
import { text } from "../lib/channel-text.js";
import * as telegram from "../lib/telegram.js";
import { languageOf } from "./suggestions.service.js";
import { receiveMessage, decide, say, handToTeam } from "./chat.service.js";
import { notify } from "./delivery.service.js";
import { firstTime } from "./channels.service.js";
import { widgetTexts } from "./translations.service.js";

/**
 * The Telegram side of a conversation: who is writing, what they sent, and what a tapped button
 * means. Everything after that is the same chat engine the widget uses, so an answer, a
 * confirmation and a handoff behave identically on both.
 */

// Telegram lets a bot download up to 20 MB, but the agent reads files up to 10, like the widget.
const MAX_FILE = 10 * 1024 * 1024;
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

/**
 * Customers often send a few messages in a row ("salom", "buyurtmam qayerda", "4127"), and an
 * album arrives as one message per photo. A chat's messages are handled one after another, and
 * the ones that arrive within BURST_MS of each other get a single answer that has read them all.
 */
const burstMs = () => Number(process.env.TELEGRAM_BURST_MS ?? 1200);
const chats = new Map(); // "<channel>:<chat>" → { waiting, timer, chain, busy }

function chatQueue(key) {
  let q = chats.get(key);
  if (!q) chats.set(key, (q = { waiting: [], timer: null, chain: Promise.resolve(), busy: 0 }));
  return q;
}

/** Runs `work` after everything already queued for this chat. */
function inChat(key, work) {
  const q = chatQueue(key);
  q.busy++;
  q.chain = q.chain
    .then(work)
    .catch((e) => console.error(`Telegram chat ${key} failed:`, e.message))
    .finally(() => {
      if (--q.busy === 0 && !q.waiting.length && !q.timer) chats.delete(key);
    });
  return q.chain;
}

/** Holds a message briefly, so one answer covers the burst it belongs to. */
function collect(key, message, handle) {
  const q = chatQueue(key);
  q.waiting.push(message);
  clearTimeout(q.timer);
  q.timer = setTimeout(() => {
    q.timer = null;
    const batch = q.waiting.splice(0);
    inChat(key, () => handle(batch));
  }, burstMs());
}

/** The published agent behind a channel, with the workspace name the AI introduces itself with. */
async function agentFor(channel) {
  const { rows } = await query(
    "SELECT a.*, w.name AS workspace_name FROM agents a JOIN workspaces w ON w.id = a.workspace_id WHERE a.id = $1 AND a.status = 'active'",
    [channel.agent_id]
  );
  return rows[0] || null;
}

/** The open conversation for this chat, or a new one. The chat itself is the customer's identity. */
async function openConversation(agent, channel, chat, from) {
  const chatId = String(chat.id);
  const { rows } = await query(
    "SELECT * FROM conversations WHERE channel_id = $1 AND channel_chat_id = $2 AND status <> 'resolved' ORDER BY created_at DESC LIMIT 1",
    [channel.id, chatId]
  );
  if (rows[0]) return rows[0];

  const visitor = {
    name: [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || "",
    language: languageOf(from.language_code),
    telegram_username: from.username || null,
    telegram_user_id: String(from.id),
  };
  // Telegram has already authenticated the person, and the chat id is the only way back to them,
  // so it stands in for the token the widget hands a browser.
  const { rows: created } = await query(
    `INSERT INTO conversations (workspace_id, agent_id, channel, channel_id, channel_chat_id, visitor, visitor_token_hash, unread, visitor_seen_at)
     VALUES ($1, $2, 'telegram', $3, $4, $5, $6, false, now()) RETURNING *`,
    [agent.workspace_id, agent.id, channel.id, chatId, visitor, hash(`${channel.id}:${chatId}`)]
  );
  return created[0];
}

/** Keeps the three dots alive while an answer is being written. */
async function whileWorking(channel, chatId, work) {
  const tick = () => telegram.sendChatAction(channel.token, chatId).catch(() => {});
  await tick();
  const timer = setInterval(tick, 4000);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/** The file on a message, downloaded, in the shape the attachment pipeline expects. */
async function attachmentOf(channel, message) {
  const photo = message.photo?.length ? message.photo[message.photo.length - 1] : null;
  const file = photo || message.document || null;
  if (!file) return { file: null, refused: null };
  if ((file.file_size || 0) > MAX_FILE) return { file: null, refused: "fileTooBig" };
  const found = await telegram.getFile(channel.token, file.file_id);
  const buffer = await telegram.download(channel.token, found.file_path);
  const name = message.document?.file_name || found.file_path.split("/").pop() || "photo.jpg";
  return { file: { buffer, originalname: name, mimetype: message.document?.mime_type }, refused: null };
}

/** The greeting, with the suggested questions and "Talk to a person" as buttons to tap. */
async function greet(agent, conv, language) {
  const { welcome, suggestions } = await widgetTexts(agent, language);
  const replies = [...(suggestions || []).map((q) => [q]), ...(agent.handoff ? [[text(language, "person")]] : [])];
  if (welcome) await say(conv, { role: "ai", body: welcome, kind: "answer" }, { replies });
}

/** The customer asked for a person (the button, or /operator): the team takes the chat. */
async function askForPerson(agent, conv, body, language) {
  await receiveMessage(agent, conv, { text: body, file: null }, { answer: false });
  if (conv.status === "ai") await handToTeam(agent, conv, "The customer asked for a person");
  await notify(conv, text(language, "handoff"));
}

/** A burst of messages from one chat: all are kept, and the last readable one is answered. */
async function answerBatch(channel, agent, messages) {
  const first = messages[0];
  let conv = await openConversation(agent, channel, first.chat, first.from || {});
  const language = conv.visitor?.language || "en";
  const readable = [];
  for (const message of messages) {
    let attachment = { file: null, refused: null };
    try {
      attachment = await attachmentOf(channel, message);
    } catch (e) {
      console.error(`Could not read a file from chat ${message.chat.id}:`, e.message);
      attachment = { file: null, refused: "wrong" };
    }
    const body = message.text || message.caption || "";
    // A sticker, a location, a voice note, a file too big: say why, and carry on with the rest.
    if (attachment.refused || (!body && !attachment.file)) await notify(conv, text(language, attachment.refused || "fileType"));
    if (body || attachment.file) readable.push({ body, file: attachment.file });
  }
  if (!readable.length) return;
  await whileWorking(channel, first.chat.id, async () => {
    for (const [i, item] of readable.entries()) {
      try {
        ({ conv } = await receiveMessage(agent, conv, { text: item.body, file: item.file }, { answer: i === readable.length - 1 }));
      } catch (e) {
        // A file the agent can't read, or a message it can't take: say so instead of going quiet.
        await notify(conv, e.status === 415 ? text(language, "fileType") : text(language, "wrong"));
        if (!e.status) console.error(`Telegram message failed for conversation ${conv.id}:`, e.message);
      }
    }
  });
}

function handleMessage(channel, agent, message) {
  // Groups need mention handling and a privacy-mode setup of their own; one to one only for now.
  if (message.chat?.type !== "private") return;
  const key = `${channel.id}:${message.chat.id}`;
  const said = (message.text || "").trim();
  const command = said.split(/[\s@]/)[0];
  if (command === "/start" || command === "/operator") {
    return inChat(key, async () => {
      const conv = await openConversation(agent, channel, message.chat, message.from || {});
      const language = conv.visitor?.language || "en";
      if (command === "/start") await greet(agent, conv, language);
      else if (agent.handoff) await askForPerson(agent, conv, text(language, "person"), language);
      else await answerBatch(channel, agent, [message]);
    });
  }
  // The "Talk to a person" button sends its own label, in the customer's language.
  return inChat(key, async () => {
    const conv = await openConversation(agent, channel, message.chat, message.from || {});
    const language = conv.visitor?.language || "en";
    if (agent.handoff && said && said === text(language, "person")) return askForPerson(agent, conv, said, language);
    collect(key, message, (batch) => answerBatch(channel, agent, batch));
  });
}

function handleCallback(channel, agent, callback) {
  const chatId = callback.message?.chat?.id;
  // Stops the spinner on the tapped button straight away; the answer follows as a message.
  telegram.answerCallbackQuery(channel.token, callback.id).catch(() => {});
  const [action, actionId] = String(callback.data || "").split(":");
  if (!["confirm", "cancel"].includes(action) || !actionId || chatId == null) return;
  return inChat(`${channel.id}:${chatId}`, async () => {
    const { rows } = await query("SELECT * FROM conversations WHERE channel_id = $1 AND channel_chat_id = $2 ORDER BY created_at DESC LIMIT 1", [channel.id, String(chatId)]);
    const conv = rows[0];
    if (!conv) return;
    await whileWorking(channel, chatId, async () => {
      try {
        await decide(agent, conv, actionId, action === "confirm");
      } catch (e) {
        // 409: the same card was already confirmed or cancelled. The buttons are about to go.
        if (e.status !== 409) console.error(`Telegram decision failed for conversation ${conv.id}:`, e.message);
      }
    });
  });
}

/**
 * One update from Telegram. Returns quietly for anything this agent can't act on: Telegram
 * redelivers whatever is not acknowledged, so an update is never refused back to it.
 */
export async function handleUpdate(channel, update) {
  if (!(await firstTime(channel.id, update.update_id))) return;
  const agent = await agentFor(channel);
  if (!agent) {
    // Nothing to answer with: the agent is a draft, paused or gone. The customer hears that much
    // rather than silence, and the owner gets a trail for why a connected bot went quiet.
    console.warn(`Channel ${channel.id} has no published agent, so an update was dropped.`);
    const message = update.message;
    if (message?.chat?.type === "private") {
      await telegram.sendMessage(channel.token, message.chat.id, text(languageOf(message.from?.language_code), "unavailable")).catch(() => {});
    }
    return;
  }
  if (update.message) return handleMessage(channel, agent, update.message);
  if (update.callback_query) return handleCallback(channel, agent, update.callback_query);
}
