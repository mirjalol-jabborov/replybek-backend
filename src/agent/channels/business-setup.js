import crypto from "crypto";
import { HttpError } from "../../core/http.js";
import { decrypt } from "../../core/secrets.js";
import * as telegram from "./telegram-api.js";
import { logActivity } from "../../core/activity/activity.js";
import { pollingMode } from "./polling.js";
import { webhookUrl, ownChannel, refusal } from "./channels.js";
import { hashCode, businessOf, updateBusiness } from "./business.js";

const LINK_MINUTES = 30;

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
