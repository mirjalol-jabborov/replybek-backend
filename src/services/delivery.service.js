import { query } from "../db.js";
import { text } from "../lib/channel-text.js";
import * as telegram from "../lib/telegram.js";
import { channelFor, disableChannel, businessConnection } from "./channels.service.js";
import { connectUrl } from "./integrations.service.js";

/**
 * Where a message goes once it is saved. The widget fetches its own messages, so nothing is
 * pushed to it; a messaging channel has to be sent to. This is the only place that knows the
 * difference, so the chat engine can stay the same everywhere.
 */

/** Telegram allows about one message per second per chat, so sends to one chat run in order. */
const chains = new Map();
function inOrder(key, run) {
  const next = (chains.get(key) || Promise.resolve()).then(run, run);
  chains.set(key, next.catch(() => {}).finally(() => chains.get(key) === next && chains.delete(key)));
  return next;
}

const wait = (seconds) => new Promise((done) => setTimeout(done, Math.min(seconds, 30) * 1000));

/** One send, retried once when Telegram asks us to slow down. */
async function send(channel, run) {
  try {
    return await run();
  } catch (e) {
    if (e instanceof telegram.TelegramError && e.retryAfter) {
      await wait(e.retryAfter);
      return run();
    }
    if (e instanceof telegram.TelegramError && e.unauthorized) await disableChannel(channel.id, "The bot token was revoked. Connect the channel again.");
    throw e;
  }
}

/** The buttons under a message, if it carries a card the customer has to act on. */
async function keyboardFor(conv, card, language) {
  if (!card || card.status === "done" || card.status === "cancelled") return null;
  if (card.type === "confirm") {
    return [[
      { text: text(language, "confirm"), callback_data: `confirm:${card.action_id}` },
      { text: text(language, "cancel"), callback_data: `cancel:${card.action_id}` },
    ]];
  }
  if (card.type === "connect") {
    // connectUrl only needs the agent's id, to check the integration belongs to it.
    const link = await connectUrl({ id: conv.agent_id }, conv.id, card.integration_id).catch(() => null);
    return link ? [[{ text: text(language, "signInTo", { name: card.name }), url: link.url }]] : null;
  }
  return null;
}

/** A confirmation as plain text: its title, its lines, and its total, the way the widget shows it. */
function cardText(card, language) {
  if (!card || card.type !== "confirm") return "";
  const lines = (card.lines || []).map(([label, value]) => `${label}: ${value}`);
  if (card.total) lines.push(String(card.total));
  return [text(language, "pleaseConfirm"), card.title, ...lines].filter(Boolean).join("\n");
}

export const languageOf = (conv) => conv.visitor?.language || "en";

/**
 * The Telegram chat a conversation goes to, and for a Telegram Business chat the connection to send
 * as. Null when a business chat can't be answered now (the owner removed the bot, or took away its
 * permission to reply).
 */
function targetOf(channel, conv) {
  if (conv.channel !== "telegram_business") return { chatId: conv.channel_chat_id, business: null };
  const business = businessConnection(channel);
  return business ? { chatId: conv.channel_chat_id.replace(/^biz:/, ""), business } : null;
}

/**
 * Hands a saved message to the channel that carries this conversation. Never throws: a message
 * that can't be delivered is logged and the conversation carries on, so one bad send doesn't
 * lose the answer that is already in the inbox.
 */
export async function deliver(conv, message, { replies } = {}) {
  if (conv.channel === "widget") return;
  try {
    const channel = await channelFor(conv);
    if (!channel) return;
    if (channel.type === "telegram") await toTelegram(channel, conv, message, replies);
  } catch (e) {
    console.error(`Delivery failed for conversation ${conv.id}:`, e.message);
  }
}

/**
 * Something the customer should read that is not part of the conversation: why a file was
 * refused, or that something went wrong. Nothing is saved, so the transcript stays what was said.
 */
export const notify = (conv, body) => deliver(conv, { body });

async function toTelegram(channel, conv, message, replies) {
  const target = targetOf(channel, conv);
  if (!target) throw new Error("Telegram Business is not connected, so the message stays in the inbox only.");
  const { chatId, business } = target;
  const language = languageOf(conv);
  const body = [message.body, cardText(message.card, language)].filter(Boolean).join("\n\n");
  const parts = telegram.split(body);
  if (message.file) {
    // A teammate's attachment goes with its own text as the caption, so it arrives as one thing.
    const caption = parts.length === 1 ? parts.shift() : "";
    await inOrder(`${channel.id}:${conv.channel_chat_id}`, () => send(channel, () => telegram.sendFile(channel.token, chatId, message.file, caption, business)));
  }
  if (!parts.length) return;
  const keyboard = await keyboardFor(conv, message.card, language);
  await inOrder(`${channel.id}:${conv.channel_chat_id}`, async () => {
    let last;
    for (const [i, part] of parts.entries()) {
      // The buttons belong under the last part, so they sit at the bottom of the whole answer.
      const isLast = i === parts.length - 1;
      last = await send(channel, () => telegram.sendMessage(channel.token, chatId, part, { keyboard: isLast ? keyboard : null, replies: isLast && !keyboard ? replies : null, business }));
    }
    if (message.id && last?.message_id) {
      await query("UPDATE messages SET channel_message_id = $2 WHERE id = $1", [message.id, String(last.message_id)]);
    }
  });
}

/**
 * A card has been decided: the buttons come off, so nobody can press Confirm twice, and the
 * message says what happened instead.
 */
export async function settleCard(conv, actionId, status) {
  if (conv.channel === "widget") return;
  try {
    const channel = await channelFor(conv);
    if (!channel || channel.type !== "telegram") return;
    const { rows } = await query(
      "SELECT id, body, card, channel_message_id FROM messages WHERE conversation_id = $1 AND card->>'action_id' = $2 AND channel_message_id IS NOT NULL ORDER BY seq DESC LIMIT 1",
      [conv.id, actionId]
    );
    const message = rows[0];
    if (!message) return;
    const target = targetOf(channel, conv);
    if (!target) return;
    const language = languageOf(conv);
    const label = status === "done" ? "confirmed" : status === "cancelled" ? "cancelled" : "failed";
    const body = [message.body, cardText(message.card, language), text(language, label)].filter(Boolean).join("\n\n");
    await inOrder(`${channel.id}:${conv.channel_chat_id}`, () =>
      send(channel, () => telegram.editMessageText(channel.token, target.chatId, Number(message.channel_message_id), telegram.split(body)[0], { business: target.business }))
    );
  } catch (e) {
    console.error(`Could not settle the card on conversation ${conv.id}:`, e.message);
  }
}
