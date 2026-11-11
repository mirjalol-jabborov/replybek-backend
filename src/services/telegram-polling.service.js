import { query } from "../db.js";
import * as telegram from "../lib/telegram.js";
import { loadChannel, disableChannel } from "./channels.service.js";
import { handleUpdate } from "./telegram.service.js";

/**
 * How a Telegram bot works on a machine Telegram can't reach. A webhook needs a public HTTPS
 * address; on a laptop there isn't one, and a tunnel dies with the terminal that started it. So in
 * development the bot asks Telegram for its updates instead, and everything after that is the same
 * code the webhook uses.
 */

/** Whether this machine collects updates itself. Production always uses webhooks. */
export function pollingMode() {
  if (process.env.TELEGRAM_POLLING) return process.env.TELEGRAM_POLLING === "true";
  if (["production", "test"].includes(process.env.NODE_ENV)) return false;
  return !/^https:/i.test(process.env.PUBLIC_API_URL || "");
}

const running = new Map(); // channel id → stop()

export function stopPolling(channelId) {
  if (channelId) return running.get(channelId)?.();
  for (const stop of running.values()) stop();
}

/**
 * Asks Telegram for this channel's updates until it is stopped. Each update is acknowledged by
 * asking for the one after it, so nothing is lost if this process restarts mid-answer.
 */
export function startPolling(channelId) {
  if (running.has(channelId)) return;
  let stopped = false;
  running.set(channelId, () => {
    stopped = true;
    running.delete(channelId);
  });
  (async function loop() {
    let offset = 0;
    while (!stopped) {
      const channel = await loadChannel(channelId).catch(() => null);
      if (!channel) break;
      try {
        const updates = await telegram.getUpdates(channel.token, { offset });
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          await handleUpdate(channel, update).catch((e) => console.error(`Telegram update failed on channel ${channelId}:`, e.message));
        }
      } catch (e) {
        if (e instanceof telegram.TelegramError && e.unauthorized) {
          await disableChannel(channelId, "The bot token was revoked. Connect the channel again.");
          break;
        }
        // A dropped connection or a rate limit: wait a little and ask again.
        await new Promise((done) => setTimeout(done, (e?.retryAfter || 3) * 1000));
      }
    }
    running.delete(channelId);
  })();
}

/** Picks up the channels that were already connected when this process last ran. */
export async function startPollingChannels() {
  if (!pollingMode()) return 0;
  const { rows } = await query("SELECT id FROM agent_channels WHERE type = 'telegram' AND status = 'active'");
  for (const row of rows) startPolling(row.id);
  if (rows.length) console.log(`Telegram: asking for updates for ${rows.length} bot(s); no webhook on this machine.`);
  return rows.length;
}
