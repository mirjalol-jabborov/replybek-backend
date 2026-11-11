import crypto from "crypto";
import { query } from "../db.js";
import { text } from "../lib/channel-text.js";
import * as telegram from "../lib/telegram.js";
import { languageOf } from "./suggestions.service.js";
import { receiveMessage, decide, say } from "./chat.service.js";
import { notify } from "./delivery.service.js";
import { firstTime } from "./channels.service.js";

/**
 * The Telegram side of a conversation: who is writing, what they sent, and what a tapped button
 * means. Everything after that is the same chat engine the widget uses, so an answer, a
 * confirmation and a handoff behave identically on both.
 */

// Telegram lets a bot download up to 20 MB, but the agent reads files up to 10, like the widget.
const MAX_FILE = 10 * 1024 * 1024;
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

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

async function handleMessage(channel, agent, message) {
  // Groups need mention handling and a privacy-mode setup of their own; one to one only for now.
  if (message.chat?.type !== "private") return;
  const conv = await openConversation(agent, channel, message.chat, message.from || {});
  const language = conv.visitor?.language || "en";

  if (message.text === "/start") {
    const welcome = agent.welcome_i18n?.[language] || agent.welcome;
    if (welcome) await say(conv, { role: "ai", body: welcome, kind: "answer" });
    return;
  }

  let attachment = { file: null, refused: null };
  try {
    attachment = await attachmentOf(channel, message);
  } catch (e) {
    console.error(`Could not read a file from chat ${message.chat.id}:`, e.message);
    attachment = { file: null, refused: "wrong" };
  }
  const body = message.text || message.caption || "";
  if (!body && !attachment.file) {
    // A sticker, a location, a voice note: nothing the agent can read.
    await notify(conv, text(language, attachment.refused || "fileType"));
    return;
  }
  if (attachment.refused) await notify(conv, text(language, attachment.refused));

  await whileWorking(channel, message.chat.id, async () => {
    try {
      await receiveMessage(agent, conv, { text: body, file: attachment.file });
    } catch (e) {
      // A file the agent can't read, or a message it can't take: say so instead of going quiet.
      await notify(conv, e.status === 415 ? text(language, "fileType") : text(language, "wrong"));
      if (!e.status) console.error(`Telegram message failed for conversation ${conv.id}:`, e.message);
    }
  });
}

async function handleCallback(channel, agent, callback) {
  const [action, actionId] = String(callback.data || "").split(":");
  // Stops the spinner on the tapped button straight away; the answer follows as a message.
  await telegram.answerCallbackQuery(channel.token, callback.id).catch(() => {});
  if (!["confirm", "cancel"].includes(action) || !actionId) return;
  const { rows } = await query("SELECT * FROM conversations WHERE channel_id = $1 AND channel_chat_id = $2 ORDER BY created_at DESC LIMIT 1", [channel.id, String(callback.message?.chat?.id)]);
  const conv = rows[0];
  if (!conv) return;
  await whileWorking(channel, callback.message.chat.id, async () => {
    try {
      await decide(agent, conv, actionId, action === "confirm");
    } catch (e) {
      // 409: the same card was already confirmed or cancelled. The buttons are about to go.
      if (e.status !== 409) console.error(`Telegram decision failed for conversation ${conv.id}:`, e.message);
    }
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
    // Nothing to answer with: the agent is a draft, paused or gone. Telegram still gets its 200,
    // but the owner needs a trail for why a connected bot went quiet.
    console.warn(`Channel ${channel.id} has no published agent, so an update was dropped.`);
    return;
  }
  if (update.message) return handleMessage(channel, agent, update.message);
  if (update.callback_query) return handleCallback(channel, agent, update.callback_query);
}
