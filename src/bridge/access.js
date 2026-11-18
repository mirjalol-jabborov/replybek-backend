// When the AI agent may work in the CRM: the workspace has both products, the business switched
// the connection on in CRM settings (settings.aiConnected), and at least one module is on.
// Writes also need settings.aiAct. Anything else: no CRM tools at all.
import { query } from "../core/db.js";
import { read } from "../crm/db.js";
import { view } from "../crm/core/settings.js";

/**
 * The CRM around one chat, or null when the AI agent may not work in it:
 * { workspace: { id, name, products }, agentKey, conversationId, channel, visitor,
 *   modules: { booking, store }, act }.
 * `conversationId` may be null (the Playground): then only lookups work.
 */
export async function crmAccess(agent, conversationId = null) {
  const { rows } = await query(
    "SELECT w.name, w.products, c.channel, c.visitor FROM workspaces w LEFT JOIN conversations c ON c.id = $2 AND c.workspace_id = w.id WHERE w.id = $1",
    [agent.workspace_id, conversationId]
  );
  const w = rows[0];
  if (!w || !w.products.includes("agent") || !w.products.includes("crm")) return null;
  const { settings, modules } = view(await read(agent.workspace_id, async (q, cfg) => cfg.data), { products: w.products });
  const on = { booking: Boolean(modules.booking), store: Boolean(modules.store) };
  if (!settings.aiConnected || (!on.booking && !on.store)) return null;
  return {
    workspace: { id: agent.workspace_id, name: w.name, products: w.products },
    agentKey: agent.public_key || null,
    conversationId: w.channel ? conversationId : null,
    channel: w.channel || null,
    visitor: w.visitor || {},
    modules: on,
    act: settings.aiAct !== false,
  };
}
