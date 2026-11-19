// When the AI agent may work in the CRM. The CRM owns the choice (settings.ai, src/crm/core/ai-link.js):
// the workspace has both products, this is the agent the CRM chose, the chat comes in on a channel
// the CRM allows (the website chat, Telegram; the dashboard's Playground, which has no conversation,
// always works for the chosen agent so the owner can try it), and at least one module is on at a
// level above "off". A module at "answer" gets its lookups; at "act" also its changes, as long as
// the CRM isn't read-only (billed and not paid for: the same decision as the team's writes).
// Anything else: no CRM tools at all.
import { query } from "../core/db.js";
import { writeRefusal } from "../core/billing/product-access.js";
import { read } from "../crm/db.js";
import { aiLink, agentsOf, levelsOf, cartOf } from "../crm/core/ai-link.js";

/** The CRM's name for the channel a conversation came in on. */
const CHANNELS = { widget: "widget", telegram: "telegram", telegram_business: "telegram" };

/** The link of a workspace that has both products, as it holds now: { ai, modules, agents }, or null. */
export async function linkOf(workspace) {
  if (!workspace.products.includes("agent") || !workspace.products.includes("crm")) return null;
  return read(workspace.id, async (q, cfg) => {
    const agents = await agentsOf(q, workspace);
    return { ai: aiLink(cfg.data.settings, cfg.data.modules, agents), modules: cfg.data.modules, agents };
  });
}

/**
 * The CRM around one chat, or null when the AI agent may not work in it:
 * { workspace: { id, name, products }, agentKey, conversationId, channel, visitor,
 *   levels: { booking, store }, modules: { booking, store }, act: { booking, store } }.
 * `agent` needs id and workspace_id. `conversationId` null is the Playground: only lookups work.
 */
export async function crmAccess(agent, conversationId = null) {
  const { rows } = await query(
    "SELECT w.*, c.id AS conversation_id, c.channel, c.visitor FROM workspaces w LEFT JOIN conversations c ON c.id = $2 AND c.workspace_id = w.id AND c.agent_id = $3 WHERE w.id = $1",
    [agent.workspace_id, conversationId, agent.id]
  );
  const w = rows[0];
  // A conversation named but not found (another agent's, say) is never taken for the Playground.
  if (!w || (conversationId && !w.conversation_id)) return null;
  const link = await linkOf(w);
  if (!link || link.ai.agentId !== agent.id) return null;
  if (w.channel && !link.ai.channels[CHANNELS[w.channel]]) return null;
  const levels = levelsOf(link.ai, link.modules);
  if (levels.booking === "off" && levels.store === "off") return null;
  const writable = !writeRefusal(w, "crm");
  return {
    workspace: { id: agent.workspace_id, name: w.name, products: w.products },
    agentKey: agent.public_key || null,
    conversationId: w.conversation_id || null,
    channel: w.channel || null,
    visitor: w.visitor || {},
    levels,
    modules: { booking: levels.booking !== "off", store: levels.store !== "off" },
    act: { booking: levels.booking === "act" && writable, store: levels.store === "act" && writable },
    // Where a card's "Add to cart" puts things (settings.ai.cart): the chat's cart or the website's.
    cart: cartOf(link.ai.cart),
  };
}

/**
 * The website cart a product card's "Add to cart" fills, for the widget's settings: { url } when
 * the CRM says so for this agent (Orders at "act", the website chat on), else null.
 */
export async function siteCartFor(agent) {
  const access = await crmAccess(agent).catch(() => null);
  if (!access?.act.store || access.cart.mode !== "site") return null;
  const link = await linkOf(access.workspace);
  return link?.ai.channels.widget ? { url: access.cart.url } : null;
}
