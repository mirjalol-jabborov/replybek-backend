import { query, tx } from "../../core/db.js";
import { text } from "./text.js";
import * as telegram from "./telegram-api.js";
import { languageOf } from "../answers/suggestions.js";
import { loadChannel } from "./channels.js";
import { linkBusinessOwner, saveBusinessConnection } from "./business.js";
import { addMessage, addMessageWithFile } from "../inbox/conversations.js";
import { chatQueue, inChat, arrived, collect } from "./chat-queue.js";
import { openConversation, attachmentOf, answerBatch } from "./telegram-chat.js";

/** The owner's own reply to the bot's private chat with them: a note about the business setup. */
const tellOwner = (channel, chatId, language, key, params) => telegram.sendMessage(channel.token, chatId, text(languageOf(language), key, params)).catch(() => {});

/** "/start biz_<code>": the owner opened the dashboard's link, so this Telegram account is theirs. */
export async function linkOwner(channel, message, code) {
  const from = message.from || {};
  const outcome = await linkBusinessOwner(channel, code, from);
  if (!outcome) return;
  if (outcome === "expired") return tellOwner(channel, message.chat.id, from.language_code, "businessLinkExpired");
  // The bot may already have been added in Telegram Business before the link was opened.
  const fresh = await loadChannel(channel.id);
  const added = Object.values(fresh?.config.business?.connections || {}).some((c) => c.user_id === from.id && c.enabled);
  await tellOwner(channel, message.chat.id, from.language_code, added ? "businessConnected" : "businessLinked", { bot: channel.config.account_name || "" });
}

/** Telegram Business added, changed or removed the bot. The owner hears whether it is answering now. */
export async function onBusinessConnection(channel, connection) {
  const { isOwner, answering } = await saveBusinessConnection(channel, connection);
  if (!isOwner || !connection.is_enabled || connection.user_chat_id == null) return;
  await tellOwner(channel, connection.user_chat_id, connection.user?.language_code, answering ? "businessConnected" : "businessNoReply");
}

/** The workspace member who linked the business account, if they are still in the workspace. */
async function memberOf(channel, memberId) {
  if (!memberId) return null;
  const { rows } = await query("SELECT user_id FROM memberships WHERE workspace_id = $1 AND user_id = $2", [channel.workspace_id, memberId]);
  return rows[0]?.user_id || null;
}

/**
 * The owner wrote in a business chat from their own Telegram. It goes in the transcript as a team
 * reply, and the chat is theirs from then on: the AI stays out of it until it is handed back.
 */
async function ownerWrote(channel, agent, message, owner) {
  const chat = message.chat;
  const conv = await openConversation(agent, channel, chat, { id: chat.id, first_name: chat.first_name, last_name: chat.last_name, username: chat.username }, true);
  let file = null;
  try {
    file = (await attachmentOf(channel, message)).file;
  } catch (e) {
    console.error(`Could not read the owner's file in chat ${chat.id}:`, e.message);
  }
  const body = message.text || message.caption || "";
  if (!body && !file) return; // a sticker or a voice note: nothing the transcript can show
  const member = await memberOf(channel, owner.member_id);
  if (conv.status !== "human") {
    await tx(async (c) => {
      await c.query("UPDATE conversations SET status = 'human', assignee_id = $2, escalated_at = COALESCE(escalated_at, now()) WHERE id = $1", [conv.id, member]);
      await addMessage(c, conv, { role: "system", body: "Replied in Telegram · AI paused" });
    });
  }
  try {
    await addMessageWithFile(conv, { role: "human", body, author_id: member }, file);
  } catch {
    // A file the inbox can't keep (its type or size): the words still go in.
    await addMessage({ query }, conv, { role: "human", body: body || file.originalname, author_id: member });
  }
}

/**
 * A message in one of the owner's business chats. Only the linked owner's connection counts, and
 * only while Telegram lets the bot reply there. The bot's own messages come back as updates too.
 */
export async function handleBusinessMessage(channel, agent, message) {
  if (message.chat?.type !== "private" || message.sender_business_bot) return;
  // Read now: a link or a connection may have changed since this channel was loaded.
  let business = (await loadChannel(channel.id))?.config.business || {};
  // A connection we never heard about (its report came while we weren't listening, or was
  // forgotten): Telegram can tell us about it, so the chat isn't ignored.
  if (business.owner && message.business_connection_id && !business.connections?.[message.business_connection_id]) {
    try {
      await saveBusinessConnection(channel, await telegram.getBusinessConnection(channel.token, message.business_connection_id));
      business = (await loadChannel(channel.id))?.config.business || {};
    } catch (e) {
      console.error(`Couldn't look up business connection on channel ${channel.id}:`, e.message);
    }
  }
  const owner = business.owner;
  const connection = business.connections?.[message.business_connection_id];
  if (!owner || !connection || connection.user_id !== owner.id || !connection.enabled) return;
  const key = `${channel.id}:biz:${message.chat.id}`;
  if (message.from?.id === owner.id) return inChat(key, () => ownerWrote(channel, agent, message, owner));
  if (!connection.can_reply) return;
  const done = arrived(key);
  return inChat(key, async () => {
    try {
      // The dots right away, so the short wait for more messages doesn't look like silence.
      if (!chatQueue(key).waiting.length) telegram.sendChatAction(channel.token, message.chat.id, "typing", message.business_connection_id).catch(() => {});
      collect(key, message, (batch) => answerBatch(channel, agent, batch, message.business_connection_id, key));
    } finally {
      done();
    }
  });
}
