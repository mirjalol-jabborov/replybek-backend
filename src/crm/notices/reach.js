// How a message can reach a customer in this workspace, for the Messages screen: one cheap answer,
// asked of the channels themselves (core/senders.js), so this area knows no channel's tables.
import { readyChannels } from "../../core/senders.js";

/**
 * { reach, channels }. `channels`: the ways out this workspace has now, in the order they are
 * tried ("telegram", "sms"). `reach`, as the screen words it: "bot" (a Telegram bot is connected),
 * "nobot" (the workspace has the AI agent, whose bot is the way, but none is connected) or
 * "noagent" (no AI agent here, so no bot either).
 */
export async function reachOf(workspace) {
  const channels = await readyChannels(workspace.id);
  const reach = channels.includes("telegram") ? "bot" : (workspace.products || []).includes("agent") ? "nobot" : "noagent";
  return { reach, channels };
}
