import crypto from "crypto";
import { query, tx } from "../db.js";
import { HttpError, notFound } from "../lib/http.js";
import { encrypt, decrypt } from "../lib/secrets.js";
import * as telegram from "../lib/telegram.js";
import { text, LANGUAGES } from "../lib/channel-text.js";
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
  // What the greeting offers as buttons: the agent's suggested questions, and "Talk to a person".
  settings: { suggestions: row.config.suggestions !== false, person_button: row.config.person_button !== false },
  business: businessOf(row),
  created_at: row.created_at,
});

/**
 * Telegram Business: the same bot, added by a business account (the owner's own Telegram) in
 * Settings > Chat Automation, answers the customers who write to that account.
 *
 * Anyone can add any bot there (it needs no Premium), so a connection only counts once its account
 * is the workspace's: the owner first opens a one-time link from the dashboard in that same Telegram
 * (`/start biz_<code>`), which tells us who they are. Kept in config.business:
 *   owner        { id, name, username, member_id, linked_at }  the Telegram account, and who linked it
 *   link         { hash, member_id, expires_at }               the one-time link, until it is used
 *   connections  { [id]: { user_id, enabled, can_reply } }     what Telegram reported, by connection
 */
const LINK_MINUTES = 30;
const hashCode = (code) => crypto.createHash("sha256").update(code).digest("hex");

/** The owner's connection, if Telegram reports one for their account. */
function ownerConnection(business) {
  const owner = business?.owner;
  if (!owner) return null;
  const found = Object.entries(business.connections || {}).filter(([, c]) => c.user_id === owner.id && c.enabled);
  const [id, c] = found.sort((a, b) => (b[1].date || 0) - (a[1].date || 0))[0] || [];
  return id ? { id, ...c } : null;
}

/**
 * Where the business setup stands, for the dashboard: "not_linked" (nobody has opened the link yet),
 * "linked" (the account is known, but hasn't added the bot), "no_reply" (added, without permission to
 * reply) or "connected".
 */
function businessOf(row) {
  const business = row.config.business || {};
  const owner = business.owner ? { name: business.owner.name, username: business.owner.username || null } : null;
  const connection = ownerConnection(business);
  const state = !owner ? "not_linked" : !connection ? "linked" : connection.can_reply ? "connected" : "no_reply";
  return { state, owner };
}

/** The connection to send through in a business chat, or null when the bot can't answer there. */
export function businessConnection(channel) {
  const connection = ownerConnection(channel.config.business);
  return connection?.can_reply ? connection.id : null;
}

/** Changes config.business in one step, so a connection and a link arriving together both stay. */
async function updateBusiness(channelId, change) {
  return tx(async (c) => {
    const { rows } = await c.query("SELECT config->'business' AS business FROM agent_channels WHERE id = $1 FOR UPDATE", [channelId]);
    if (!rows[0]) return null;
    const next = change(rows[0].business || {});
    await c.query("UPDATE agent_channels SET config = jsonb_set(config, '{business}', $2::jsonb) WHERE id = $1", [channelId, JSON.stringify(next)]);
    return next;
  });
}

/** Asks Telegram for the business updates too. Bots connected before Telegram Business was added only get messages and taps. */
async function askForBusinessUpdates(row) {
  if (pollingMode()) return; // each poll already names the updates it wants
  await telegram.setWebhook(decrypt(row.config.token), webhookUrl(row.id), row.config.secret, { dropPending: false });
}

/** The setup page: where things stand, and whether Secretary Mode (once Business Mode) is on for the bot in BotFather. */
export async function businessStatus(workspaceId, agentId, channelId) {
  const row = await ownChannel(workspaceId, agentId, channelId);
  if (row.status !== "active") return { ...businessOf(row), business_mode: false, bot_username: null };
  let me;
  try {
    me = await telegram.getMe(decrypt(row.config.token));
  } catch (e) {
    throw refusal(e);
  }
  return { ...businessOf(row), business_mode: me.can_connect_to_business === true, bot_username: me.username || null };
}

/** A one-time link the owner opens in their own Telegram, so the bot learns which account is theirs. */
export async function startBusinessLink(workspaceId, agentId, channelId, user) {
  const row = await ownChannel(workspaceId, agentId, channelId);
  if (row.status !== "active") throw new HttpError(409, "Connect the bot again first.");
  const username = String(row.config.account_name || "").replace(/^@/, "");
  if (!username) throw new HttpError(409, "The bot has no username, so there is no link to open. Give it one in BotFather.");
  try {
    await askForBusinessUpdates(row);
  } catch (e) {
    throw refusal(e);
  }
  const code = crypto.randomBytes(18).toString("base64url");
  const expires_at = new Date(Date.now() + LINK_MINUTES * 60000).toISOString();
  await updateBusiness(row.id, (b) => ({ ...b, link: { hash: hashCode(code), member_id: user?.id || null, expires_at } }));
  return { url: `https://t.me/${username}?start=biz_${code}`, expires_at };
}

/**
 * Someone opened the link (`/start biz_<code>`) in their Telegram: that account becomes the owner.
 * Returns "linked", "expired" (or already used), or null for a code this bot never gave out.
 */
export async function linkBusinessOwner(channel, code, from) {
  let outcome = null;
  let memberId = null;
  await updateBusiness(channel.id, (b) => {
    if (!b.link || b.link.hash !== hashCode(code)) {
      outcome = b.owner?.id === from.id ? "linked" : "expired";
      return b;
    }
    if (new Date(b.link.expires_at) < new Date()) {
      outcome = "expired";
      return { ...b, link: undefined };
    }
    outcome = "linked";
    memberId = b.link.member_id;
    const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || String(from.id);
    return { ...b, link: undefined, owner: { id: from.id, name, username: from.username || null, member_id: memberId, linked_at: new Date().toISOString() } };
  });
  if (outcome === "linked" && memberId !== null) {
    const { rows } = await query("SELECT name FROM users WHERE id = $1", [memberId]);
    await logActivity(channel.workspace_id, memberId, "{actor} linked a Telegram Business account", { actor: rows[0]?.name || "Someone" }, channel.config.account_name);
  }
  return outcome;
}

/**
 * Telegram reports that a business account added, changed or removed the bot. Kept whoever it is
 * from, so the owner can also add the bot before opening the link; only the owner's one is used.
 * Returns whether this was the owner's account, and whether it can answer now.
 */
export async function saveBusinessConnection(channel, connection) {
  const next = await updateBusiness(channel.id, (b) => ({
    ...b,
    connections: {
      ...(b.connections || {}),
      [connection.id]: { user_id: connection.user?.id, enabled: connection.is_enabled === true, can_reply: connection.rights?.can_reply === true || connection.can_reply === true, date: connection.date || 0 },
    },
  }));
  const isOwner = next?.owner?.id === connection.user?.id;
  if (isOwner) {
    const what = connection.is_enabled ? "{actor} added the bot in Telegram Business" : "{actor} removed the bot from Telegram Business";
    await logActivity(channel.workspace_id, next.owner.member_id || null, what, { actor: next.owner.name }, channel.config.account_name);
  }
  return { isOwner, answering: isOwner && Boolean(businessConnection({ config: { business: next } })) };
}

/**
 * Stops answering business chats by forgetting whose account counts. What Telegram reported about
 * the connections stays: Telegram reports a connection only when it is added or changed, so linking
 * the same account again finds it connected at once. Removing the bot itself happens in Telegram.
 */
export async function unlinkBusiness(workspaceId, agentId, channelId, user) {
  const row = await ownChannel(workspaceId, agentId, channelId);
  await updateBusiness(row.id, (b) => (b.connections ? { connections: b.connections } : {}));
  await logActivity(workspaceId, user?.id || null, "{actor} turned off Telegram Business", { actor: user?.name || "Someone" }, row.config.account_name);
  return businessOf({ config: {} });
}

async function ownChannel(workspaceId, agentId, channelId) {
  if (!/^[0-9a-f-]{36}$/i.test(channelId || "")) throw notFound("Channel not found");
  const { rows } = await query("SELECT * FROM agent_channels WHERE id = $1 AND workspace_id = $2 AND agent_id = $3", [channelId, workspaceId, agentId]);
  if (!rows[0]) throw notFound("Channel not found");
  return rows[0];
}

/** Telegram's refusal, in words an owner can act on. */
function refusal(e) {
  if (e.retryAfter) {
    const minutes = Math.ceil(e.retryAfter / 60);
    return new HttpError(429, `Telegram limits how often a bot's profile can change. Try again in ${minutes === 1 ? "a minute" : `${minutes} minutes`}.`);
  }
  if (e.unauthorized) return new HttpError(400, "Telegram no longer accepts this bot's token. Connect the bot again.");
  return new HttpError(400, `Telegram refused the change: ${e.message}`);
}

/**
 * The bot as customers see it, read from Telegram itself (it can also be changed in BotFather):
 * name, @username, photo, the "What can this bot do?" text and the profile's short description.
 */
export async function botProfile(workspaceId, agentId, channelId) {
  const row = await ownChannel(workspaceId, agentId, channelId);
  if (row.status !== "active") return { ...safe(row), profile: null };
  const token = decrypt(row.config.token);
  try {
    const [me, description, short_description, photo] = await Promise.all([
      telegram.getMe(token),
      telegram.getMyDescription(token),
      telegram.getMyShortDescription(token),
      telegram.profilePhoto(token, row.config.account_id).catch(() => null),
    ]);
    return {
      ...safe(row),
      profile: { name: me.first_name || "", username: me.username || "", description, short_description, photo: photo ? `data:image/jpeg;base64,${photo.toString("base64")}` : null },
    };
  } catch (e) {
    throw refusal(e);
  }
}

/**
 * Changes the bot: the greeting's buttons (kept here) and its Telegram profile (kept by Telegram).
 * The buttons are saved first, so a refused profile change doesn't lose them.
 */
export async function updateBot(workspaceId, agentId, channelId, user, input) {
  const row = await ownChannel(workspaceId, agentId, channelId);
  if (row.status !== "active") throw new HttpError(409, "Connect the bot again before changing it.");
  const settings = Object.fromEntries(["suggestions", "person_button"].filter((k) => k in input).map((k) => [k, input[k]]));
  if (Object.keys(settings).length) await query("UPDATE agent_channels SET config = config || $2::jsonb WHERE id = $1", [row.id, JSON.stringify(settings)]);
  const token = decrypt(row.config.token);
  try {
    if (input.name !== undefined) await telegram.setMyName(token, input.name);
    if (input.description !== undefined) await telegram.setMyDescription(token, input.description);
    if (input.short_description !== undefined) await telegram.setMyShortDescription(token, input.short_description);
    if (input.photo) await telegram.setMyProfilePhoto(token, Buffer.from(input.photo.slice(input.photo.indexOf(",") + 1), "base64"));
    else if (input.remove_photo) await telegram.removeMyProfilePhoto(token);
  } catch (e) {
    throw refusal(e);
  }
  await logActivity(workspaceId, user?.id || null, "{actor} changed the Telegram bot", { actor: user?.name || "Someone" }, row.config.account_name);
  return botProfile(workspaceId, agentId, channelId);
}

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
  // Reconnecting the same bot to this workspace (a new token, say) takes the new credentials and
  // keeps its settings and its Telegram Business link. A bot held by another workspace is excluded
  // by the WHERE, which returns no row: the one case that is a conflict.
  const { rows } = await query(
    `INSERT INTO agent_channels (workspace_id, agent_id, type, config) VALUES ($1, $2, 'telegram', $3)
     ON CONFLICT (type, (config->>'account_id')) DO UPDATE
       SET agent_id = EXCLUDED.agent_id, config = agent_channels.config || EXCLUDED.config, status = 'active', disabled_reason = NULL
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
  // The menu next to the message box, in each language the bot speaks (Telegram picks by the app's language).
  const menu = (language) => [
    { command: "start", description: text(language, "commandStart") },
    { command: "operator", description: text(language, "person") },
  ];
  await Promise.all([telegram.setMyCommands(botToken, menu("en")), ...LANGUAGES.map((language) => telegram.setMyCommands(botToken, menu(language), language))]).catch((e) =>
    console.error(`Couldn't set the menu of ${config.account_name}:`, e.message)
  );
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
