// Which Replybek AI agent works in this CRM, where, and how far (settings.ai). The CRM owns the
// choice; the bridge (src/bridge/access.js) reads it to decide which tools an answer gets.
//
//   settings.ai = { agentId: uuid | null, channels: { widget, telegram }, booking: level, store: level }
//   level: "off" (no tools for the module), "answer" (lookups only), "act" (lookups and changes,
//   each one confirmed by the customer)
//
// Workspaces from before keep only settings.aiConnected / settings.aiAct. They are read through
// aiLink() without any migration: connected meant every agent on every channel, so it reads as the
// oldest published agent (else the oldest one) on both channels, at "act" (or "answer" when aiAct
// was off) for each module that is on. A save in the new shape keeps both old keys in step
// (mirrorOldKeys); a save in the old shape (aiConnected/aiAct without ai) drops `ai`, so the old
// keys are read again.
import { z } from "zod";
import { uuid } from "../shapes.js";

export const LEVELS = ["off", "answer", "act"];
const MODULES = ["booking", "store"];

/** settings.ai as PUT /settings takes it. Saved whole. */
export const aiShape = z
  .object({
    agentId: uuid.nullable(),
    channels: z.object({ widget: z.boolean(), telegram: z.boolean() }).strict(),
    booking: z.enum(LEVELS),
    store: z.enum(LEVELS),
  })
  .strict();

/**
 * The workspace's agents the link can name, oldest first: [{ id, name, status }]. Empty without
 * the agent product (nothing to connect to, and no query).
 */
export async function agentsOf(q, workspace) {
  if (!(workspace.products || []).includes("agent")) return [];
  const { rows } = await q("SELECT id, name, status FROM agents WHERE workspace_id = $1 ORDER BY created_at, id", [workspace.id]);
  return rows;
}

/**
 * The link as it holds now: settings.ai when saved, else what aiConnected / aiAct meant. An agent
 * that is gone (deleted, or never this workspace's) reads as not connected. `agents` from agentsOf.
 */
export function aiLink(settings, modules, agents) {
  const ids = new Set(agents.map((a) => a.id));
  const saved = settings.ai;
  if (saved && typeof saved === "object") {
    return {
      agentId: ids.has(saved.agentId) ? saved.agentId : null,
      channels: { widget: saved.channels?.widget !== false, telegram: saved.channels?.telegram !== false },
      booking: LEVELS.includes(saved.booking) ? saved.booking : "off",
      store: LEVELS.includes(saved.store) ? saved.store : "off",
    };
  }
  const level = settings.aiAct === false ? "answer" : "act";
  const chosen = settings.aiConnected ? agents.find((a) => a.status === "active") || agents[0] : null;
  return {
    agentId: chosen?.id || null,
    channels: { widget: true, telegram: true },
    ...Object.fromEntries(MODULES.map((m) => [m, modules?.[m] ? level : "off"])),
  };
}

/** What each module's AI agent may do now: the saved level, "off" for a module that is off. */
export const levelsOf = (ai, modules) => Object.fromEntries(MODULES.map((m) => [m, modules?.[m] ? ai[m] : "off"]));

/**
 * The old keys for a link saved in the new shape, so code that still reads only them (a rollback)
 * never gives the agent more than the link does: connected only with an agent, a channel and a
 * module that isn't off; writes only when no module is held at "answer".
 */
export function mirrorOldKeys(ai) {
  const levels = MODULES.map((m) => ai[m]);
  return {
    aiConnected: Boolean(ai.agentId) && (ai.channels.widget || ai.channels.telegram) && levels.some((l) => l !== "off"),
    aiAct: !levels.includes("answer"),
  };
}
