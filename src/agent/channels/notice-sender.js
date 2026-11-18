// The Telegram bot as a way for the CRM to write to a customer (a booking confirmed, a reminder).
// A bot can write only to people who have written to it, so a customer is reachable when their
// Telegram username (crm customer.telegram, kept bare: "jasur_k") matches someone who chatted with
// one of the workspace's connected bots, in any letter case. Registered in core/senders.js (loaded
// by src/app.js and src/worker.js); the CRM never imports this file.
import { query } from "../../core/db.js";
import { registerSender } from "../../core/senders.js";
import * as telegram from "./telegram-api.js";
import { loadChannel, disableChannel } from "./channels.js";

/** The latest bot chat of each of these customers, on a bot that is still connected. */
async function reach(workspaceId, people) {
  const handles = new Map();
  for (const p of people) {
    const h = String(p.telegram || "").toLowerCase();
    if (h) handles.set(h, [...(handles.get(h) || []), p.id]);
  }
  if (!handles.size) return {};
  const { rows } = await query(
    `SELECT DISTINCT ON (lower(c.visitor->>'telegram_username')) lower(c.visitor->>'telegram_username') AS handle,
            c.channel_id, c.channel_chat_id, c.visitor->>'language' AS language
       FROM conversations c JOIN agent_channels ch ON ch.id = c.channel_id AND ch.status = 'active'
      WHERE c.workspace_id = $1 AND c.channel = 'telegram' AND lower(c.visitor->>'telegram_username') = ANY($2::text[])
      ORDER BY lower(c.visitor->>'telegram_username'), c.last_message_at DESC`,
    [workspaceId, [...handles.keys()]]
  );
  const out = {};
  for (const r of rows) for (const id of handles.get(r.handle) || []) out[id] = { address: `${r.channel_id}:${r.channel_chat_id}`, language: r.language };
  return out;
}

/** Telegram's refusal as a code, and whether a later try may go through. */
function outcome(e) {
  if (!(e instanceof telegram.TelegramError)) return { ok: false, code: "send_error", retry: true };
  if (e.unauthorized) return { ok: false, code: "channel_off", retry: false };
  if (e.retryAfter) return { ok: false, code: "rate_limited", retry: true };
  if (e.code === 403) return { ok: false, code: "blocked", retry: false };
  if (e.code === 400) return { ok: false, code: "unreachable", retry: false };
  return { ok: false, code: e.code === 0 ? "network" : "send_error", retry: true };
}

async function send(address, text) {
  const [channelId, chatId] = address.split(":");
  const channel = await loadChannel(channelId);
  if (!channel) return { ok: false, code: "channel_off", retry: false };
  try {
    for (const part of telegram.split(text)) await telegram.sendMessage(channel.token, chatId, part);
    return { ok: true };
  } catch (e) {
    if (e instanceof telegram.TelegramError && e.unauthorized) await disableChannel(channel.id, "The bot token was revoked. Connect the channel again.");
    return outcome(e);
  }
}

/** Whether the workspace has a connected bot: without one, nobody can be written to here. */
async function ready(workspaceId) {
  const { rows } = await query("SELECT 1 FROM agent_channels WHERE workspace_id = $1 AND type = 'telegram' AND status = 'active' LIMIT 1", [workspaceId]);
  return rows.length > 0;
}

registerSender("telegram", { reach, send, ready });
