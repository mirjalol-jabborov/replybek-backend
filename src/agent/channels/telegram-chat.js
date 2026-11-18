import crypto from "crypto";
import { query } from "../../core/db.js";
import { text } from "./text.js";
import * as telegram from "./telegram-api.js";
import { languageOf } from "../answers/suggestions.js";
import { receiveMessage } from "../inbox/chat.js";
import { notify } from "../inbox/delivery.js";
import { moreWaiting } from "./chat-queue.js";

// Telegram lets a bot download up to 20 MB, but the agent reads files up to 10, like the widget.
const MAX_FILE = 10 * 1024 * 1024;
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

/**
 * The open conversation for this chat, or a new one. The chat itself is the customer's identity.
 * A Telegram Business chat (`business`) is a different chat from the bot's own one with the same
 * person, though Telegram gives both the same id, so its key carries a "biz:" prefix.
 */
export async function openConversation(agent, channel, chat, from, business = false) {
  const chatId = business ? `biz:${chat.id}` : String(chat.id);
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
     VALUES ($1, $2, $7, $3, $4, $5, $6, false, now()) RETURNING *`,
    [agent.workspace_id, agent.id, channel.id, chatId, visitor, hash(`${channel.id}:${chatId}`), business ? "telegram_business" : "telegram"]
  );
  return created[0];
}

/** Keeps the three dots alive while an answer is being written. */
export async function whileWorking(channel, chatId, work, business = null) {
  const tick = () => telegram.sendChatAction(channel.token, chatId, "typing", business).catch(() => {});
  await tick();
  const timer = setInterval(tick, 4000);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/** The file on a message, downloaded, in the shape the attachment pipeline expects. */
export async function attachmentOf(channel, message) {
  const photo = message.photo?.length ? message.photo[message.photo.length - 1] : null;
  const file = photo || message.document || null;
  if (!file) return { file: null, refused: null };
  if ((file.file_size || 0) > MAX_FILE) return { file: null, refused: "fileTooBig" };
  const found = await telegram.getFile(channel.token, file.file_id);
  const buffer = await telegram.download(channel.token, found.file_path);
  const name = message.document?.file_name || found.file_path.split("/").pop() || "photo.jpg";
  return { file: { buffer, originalname: name, mimetype: message.document?.mime_type }, refused: null };
}

/**
 * A burst of messages from one chat: all are kept, and the last readable one is answered.
 * `business`: the connection it came through, for a Telegram Business chat.
 */
export async function answerBatch(channel, agent, messages, business = null, key = null) {
  const first = messages[0];
  let conv = await openConversation(agent, channel, first.chat, first.from || {}, Boolean(business));
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
    // A reply to one of our messages (say, a product's photo) says which one it means.
    const quoted = message.reply_to_message && (message.reply_to_message.caption || message.reply_to_message.text || "").trim();
    const said = message.text || message.caption || "";
    const body = said && quoted ? `${said}\n\n(Replying to: "${quoted.slice(0, 300)}")` : said;
    // A sticker, a location, a voice note, a file too big: say why, and carry on with the rest.
    if (attachment.refused || (!body && !attachment.file)) await notify(conv, text(language, attachment.refused || "fileType"));
    if (body || attachment.file) readable.push({ body, file: attachment.file });
  }
  if (!readable.length) return;
  await whileWorking(channel, first.chat.id, async () => {
    for (const [i, item] of readable.entries()) {
      try {
        ({ conv } = await receiveMessage(agent, conv, { text: item.body, file: item.file }, { answer: i === readable.length - 1, stale: key ? () => moreWaiting(key) : null }));
      } catch (e) {
        // A file the agent can't read, or a message it can't take: say so instead of going quiet.
        await notify(conv, e.status === 415 ? text(language, "fileType") : text(language, "wrong"));
        if (!e.status) console.error(`Telegram message failed for conversation ${conv.id}:`, e.message);
      }
    }
  }, business);
}
