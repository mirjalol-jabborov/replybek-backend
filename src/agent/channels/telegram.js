import { query } from "../../core/db.js";
import { text } from "./text.js";
import * as telegram from "./telegram-api.js";
import { languageOf } from "../answers/suggestions.js";
import { receiveMessage, decide, say, handToTeam } from "../inbox/chat.js";
import { notify } from "../inbox/delivery.js";
import { widgetTexts } from "../answers/translations.js";
import { firstTime } from "./channels.js";
import { chatQueue, inChat, arrived, collect } from "./chat-queue.js";
import { openConversation, whileWorking, answerBatch } from "./telegram-chat.js";
import { linkOwner, onBusinessConnection, handleBusinessMessage } from "./business-chats.js";

/**
 * The Telegram side of a conversation: who is writing, what they sent, and what a tapped button
 * means. Everything after that is the same chat engine the widget uses, so an answer, a
 * confirmation and a handoff behave identically on both.
 */

/** The published agent behind a channel, with the workspace name the AI introduces itself with. */
async function agentFor(channel) {
  const { rows } = await query(
    "SELECT a.*, w.name AS workspace_name FROM agents a JOIN workspaces w ON w.id = a.workspace_id WHERE a.id = $1 AND a.status = 'active'",
    [channel.agent_id]
  );
  return rows[0] || null;
}

/**
 * The greeting, with the suggested questions and "Talk to a person" as buttons to tap, as far as the
 * channel's settings allow. With neither, any buttons from an earlier greeting are taken away.
 */
async function greet(agent, conv, language, channel) {
  const { welcome, suggestions } = await widgetTexts(agent, language);
  const replies = [
    ...(channel.config.suggestions !== false ? (suggestions || []).map((q) => [q]) : []),
    ...(agent.handoff && channel.config.person_button !== false ? [[text(language, "person")]] : []),
  ];
  if (welcome) await say(conv, { role: "ai", body: welcome, kind: "answer" }, { replies });
}

/** The customer asked for a person (the button, or /operator): the team takes the chat. */
async function askForPerson(agent, conv, body, language) {
  await receiveMessage(agent, conv, { text: body, file: null }, { answer: false });
  if (conv.status === "ai") await handToTeam(agent, conv, "The customer asked for a person");
  await notify(conv, text(language, "handoff"));
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
      if (command === "/start") await greet(agent, conv, language, channel);
      else if (agent.handoff) await askForPerson(agent, conv, text(language, "person"), language);
      else await answerBatch(channel, agent, [message]);
    });
  }
  // The "Talk to a person" button sends its own label, in the customer's language.
  const done = arrived(key);
  return inChat(key, async () => {
    try {
      const conv = await openConversation(agent, channel, message.chat, message.from || {});
      const language = conv.visitor?.language || "en";
      if (agent.handoff && said && said === text(language, "person")) return askForPerson(agent, conv, said, language);
      if (!chatQueue(key).waiting.length) telegram.sendChatAction(channel.token, message.chat.id, "typing").catch(() => {});
      collect(key, message, (batch) => answerBatch(channel, agent, batch, null, key));
    } finally {
      done();
    }
  });
}

function handleCallback(channel, agent, callback) {
  const chatId = callback.message?.chat?.id;
  // Stops the spinner on the tapped button straight away; the answer follows as a message.
  telegram.answerCallbackQuery(channel.token, callback.id).catch(() => {});
  const [action, actionId] = String(callback.data || "").split(":");
  if (!["confirm", "cancel"].includes(action) || !/^[0-9a-f-]{36}$/i.test(actionId || "") || chatId == null) return;
  // A button in a Telegram Business chat comes with the connection it was sent through.
  const business = callback.message?.business_connection_id || null;
  const key = business ? `${channel.id}:biz:${chatId}` : `${channel.id}:${chatId}`;
  return inChat(key, async () => {
    // The card's own conversation, on this channel, so a tap can only decide what it was sent with.
    const { rows } = await query(
      "SELECT c.* FROM pending_actions p JOIN conversations c ON c.id = p.conversation_id WHERE p.id = $1 AND c.channel_id = $2 AND c.channel_chat_id = $3",
      [actionId, channel.id, business ? `biz:${chatId}` : String(chatId)]
    );
    const conv = rows[0];
    if (!conv) return;
    await whileWorking(channel, chatId, async () => {
      try {
        await decide(agent, conv, actionId, action === "confirm");
      } catch (e) {
        // 409: the same card was already confirmed or cancelled. The buttons are about to go.
        if (e.status !== 409) console.error(`Telegram decision failed for conversation ${conv.id}:`, e.message);
      }
    }, business);
  });
}

/**
 * One update from Telegram. Returns quietly for anything this agent can't act on: Telegram
 * redelivers whatever is not acknowledged, so an update is never refused back to it.
 */
export async function handleUpdate(channel, update) {
  if (!(await firstTime(channel.id, update.update_id))) return;
  // The business setup works whether or not the agent is published yet.
  if (update.business_connection) return onBusinessConnection(channel, update.business_connection);
  const link = update.message?.chat?.type === "private" && /^\/start\s+biz_([\w-]{10,64})$/.exec((update.message.text || "").trim());
  if (link) return linkOwner(channel, update.message, link[1]);
  const agent = await agentFor(channel);
  // In a business chat the customer is writing to a person, so a draft agent just stays out of it.
  if (update.business_message) return agent ? handleBusinessMessage(channel, agent, update.business_message) : undefined;
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
