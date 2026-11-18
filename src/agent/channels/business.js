import crypto from "crypto";
import { query, tx } from "../../core/db.js";
import { logActivity } from "../../core/activity/activity.js";

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
export const hashCode = (code) => crypto.createHash("sha256").update(code).digest("hex");

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
export function businessOf(row) {
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
export async function updateBusiness(channelId, change) {
  return tx(async (c) => {
    const { rows } = await c.query("SELECT config->'business' AS business FROM agent_channels WHERE id = $1 FOR UPDATE", [channelId]);
    if (!rows[0]) return null;
    const next = change(rows[0].business || {});
    await c.query("UPDATE agent_channels SET config = jsonb_set(config, '{business}', $2::jsonb) WHERE id = $1", [channelId, JSON.stringify(next)]);
    return next;
  });
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
