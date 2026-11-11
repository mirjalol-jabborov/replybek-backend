import crypto from "crypto";
import { query } from "../db.js";
import { HttpError, notFound } from "../lib/http.js";
import { encrypt, decrypt } from "../lib/secrets.js";
import * as telegram from "../lib/telegram.js";
import { logActivity } from "./activity.service.js";
import { pollingMode, startPolling, stopPolling } from "./telegram-polling.service.js";

/**
 * Channels an agent answers on besides its website widget. A channel holds the credentials for
 * one messaging account and nothing else: the agent, its knowledge and its integrations are the
 * same whichever channel a customer writes from.
 */

const PUBLIC_API_URL = () => (process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 3100}`).replace(/\/$/, "");
export const webhookUrl = (channelId) => `${PUBLIC_API_URL()}/channels/telegram/${channelId}`;

/** What the dashboard may see: everything except the credentials. */
const safe = (row) => ({
  id: row.id,
  agent_id: row.agent_id,
  type: row.type,
  status: row.status,
  disabled_reason: row.disabled_reason,
  account_name: row.config.account_name || null,
  created_at: row.created_at,
});

export async function listChannels(workspaceId, agentId) {
  const { rows } = await query("SELECT * FROM agent_channels WHERE workspace_id = $1 AND agent_id = $2 ORDER BY created_at", [workspaceId, agentId]);
  return rows.map(safe);
}

/**
 * Connects a Telegram bot to an agent. The token is checked against Telegram before anything is
 * stored, so a typo is a clear error rather than a channel that silently never answers.
 */
export async function connectTelegram(workspace, agentId, user, botToken) {
  const { rows: agents } = await query("SELECT id FROM agents WHERE id = $1 AND workspace_id = $2", [agentId, workspace.id]);
  if (!agents[0]) throw notFound("Agent not found");

  let me;
  try {
    me = await telegram.getMe(botToken);
  } catch (e) {
    throw new HttpError(400, e.unauthorized ? "Telegram didn't accept that token. Copy it again from BotFather." : `Telegram couldn't be reached: ${e.message}`);
  }

  const config = {
    account_id: String(me.id),
    account_name: me.username ? `@${me.username}` : me.first_name,
    secret: crypto.randomBytes(24).toString("base64url"),
    token: encrypt(botToken),
  };
  // Reconnecting the same bot to this workspace replaces its settings. A bot held by another
  // workspace is excluded by the WHERE, which returns no row: the one case that is a conflict.
  const { rows } = await query(
    `INSERT INTO agent_channels (workspace_id, agent_id, type, config) VALUES ($1, $2, 'telegram', $3)
     ON CONFLICT (type, (config->>'account_id')) DO UPDATE
       SET agent_id = EXCLUDED.agent_id, config = EXCLUDED.config, status = 'active', disabled_reason = NULL
       WHERE agent_channels.workspace_id = EXCLUDED.workspace_id
     RETURNING *`,
    [workspace.id, agentId, config]
  );
  const row = rows[0];
  if (!row) throw new HttpError(409, "That bot already answers for another workspace. Disconnect it there, or create a second bot in BotFather.");

  if (pollingMode()) {
    // This machine has no address Telegram can call, so the bot asks Telegram for its updates
    // instead. Any webhook left from another machine has to go, or Telegram keeps sending there.
    await telegram.deleteWebhook(botToken).catch(() => {});
    startPolling(row.id);
  } else {
    try {
      await telegram.setWebhook(botToken, webhookUrl(row.id), config.secret);
    } catch (e) {
      await query("DELETE FROM agent_channels WHERE id = $1", [row.id]);
      throw new HttpError(400, `Telegram refused the webhook address ${webhookUrl(row.id)}: ${e.message}`);
    }
  }
  await logActivity(workspace.id, user?.id || null, "{actor} connected a Telegram channel", { actor: user?.name || "Someone" }, config.account_name);
  return safe(row);
}

export async function disconnectChannel(workspaceId, agentId, channelId, user) {
  const { rows } = await query("SELECT * FROM agent_channels WHERE id = $1 AND workspace_id = $2 AND agent_id = $3", [channelId, workspaceId, agentId]);
  const channel = rows[0];
  if (!channel) throw notFound("Channel not found");
  stopPolling(channelId);
  // Telegram may refuse (a revoked token); the channel still goes, or it would answer nowhere.
  await telegram.deleteWebhook(decrypt(channel.config.token)).catch(() => {});
  await query("DELETE FROM agent_channels WHERE id = $1", [channelId]);
  await logActivity(workspaceId, user?.id || null, "{actor} disconnected a Telegram channel", { actor: user?.name || "Someone" }, channel.config.account_name);
  return { ok: true };
}

/** An active channel with its credentials, for the webhook and for sending. */
export async function loadChannel(channelId) {
  if (!/^[0-9a-f-]{36}$/i.test(channelId || "")) return null;
  const { rows } = await query("SELECT * FROM agent_channels WHERE id = $1 AND status = 'active'", [channelId]);
  const channel = rows[0];
  return channel ? { ...channel, token: decrypt(channel.config.token), secret: channel.config.secret } : null;
}

/** The channel a conversation arrived on, if it is still connected. */
export const channelFor = (conv) => (conv.channel_id ? loadChannel(conv.channel_id) : null);

export async function disableChannel(channelId, reason) {
  await query("UPDATE agent_channels SET status = 'disabled', disabled_reason = $2 WHERE id = $1", [channelId, reason]);
}

/**
 * True the first time an update is seen. Telegram redelivers an update until it is acknowledged,
 * and a redelivery must not answer the customer twice.
 */
export async function firstTime(channelId, updateId) {
  const { rowCount } = await query("INSERT INTO channel_updates (channel_id, update_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [channelId, String(updateId)]);
  return rowCount > 0;
}

/** Keeps the seen-updates table small; Telegram stops retrying long before this. */
export const forgetOldUpdates = () => query("DELETE FROM channel_updates WHERE received_at < now() - interval '2 days'");
