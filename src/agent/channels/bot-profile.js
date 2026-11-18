import { query } from "../../core/db.js";
import { HttpError } from "../../core/http.js";
import { decrypt } from "../../core/secrets.js";
import * as telegram from "./telegram-api.js";
import { logActivity } from "../../core/activity/activity.js";
import { safe, ownChannel, refusal } from "./channels.js";

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
