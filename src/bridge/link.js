// What each side shows about the link between the AI agent and the CRM. The CRM chooses (its
// settings.ai, saved with PUT /crm/settings); these two reads put the agent's facts next to it:
//   GET /w/:wid/crm/agent-link       CRM settings: the workspace's agents and their real channels, and the link
//   GET /w/:wid/agents/:aid/crm      the agent's page in the dashboard: whether the CRM uses this agent, and how
// Mounted by src/app.js: the first under the CRM's product guard, the second with the agent's routes.
import { Router } from "express";
import { query } from "../core/db.js";
import { notFound, wrap } from "../core/http.js";
import { levelsOf } from "../crm/core/ai-link.js";
import { linkOf } from "./access.js";

/** A site's name as people say it: "shop.uz" from "https://www.shop.uz". */
function siteOf(origin) {
  try {
    return new URL(origin).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * The workspace's agents with the channels they really have, oldest first. The website chat is one
 * once the agent has an allowed site or a website conversation; Telegram, once a bot is connected.
 * `live`: it answers there now (the agent is published, the bot works).
 * [{ id, name, status, channels: [{ type: "widget", label, more, live } | { type: "telegram", label, live }] }]
 */
async function agentsWithChannels(workspaceId) {
  const [agents, bots] = await Promise.all([
    query(
      `SELECT a.id, a.name, a.status, a.allowed_origins,
              EXISTS (SELECT 1 FROM conversations c WHERE c.agent_id = a.id AND c.channel = 'widget') AS widget_used
         FROM agents a WHERE a.workspace_id = $1 ORDER BY a.created_at, a.id`,
      [workspaceId]
    ),
    query("SELECT agent_id, status, config->>'account_name' AS name FROM agent_channels WHERE workspace_id = $1 AND type = 'telegram' ORDER BY created_at", [workspaceId]),
  ]);
  return agents.rows.map((a) => {
    const live = a.status === "active";
    const channels = [];
    if (a.allowed_origins.length || a.widget_used) {
      channels.push({ type: "widget", label: a.allowed_origins.length ? siteOf(a.allowed_origins[0]) : null, more: Math.max(0, a.allowed_origins.length - 1), live });
    }
    for (const b of bots.rows.filter((x) => x.agent_id === a.id)) channels.push({ type: "telegram", label: b.name || null, live: live && b.status === "active" });
    return { id: a.id, name: a.name, status: a.status, channels };
  });
}

/** CRM settings' view: { agents, ai } (ai as the link holds now, settings.ai's shape). */
export async function crmAgentLink(workspace) {
  const link = await linkOf(workspace);
  if (!link) return { agents: [], ai: null };
  return { agents: await agentsWithChannels(workspace.id), ai: link.ai };
}

/**
 * The dashboard's view of one agent: { crm: false } without the CRM; else
 * { crm: true, connected, modules: [{ module, level }] (the modules on in the CRM),
 *   channels: ["widget", "telegram"] (where it works with the CRM: allowed there and the agent has it) }.
 */
export async function agentCrmLink(workspace, agentId) {
  if (!/^[0-9a-f-]{36}$/i.test(agentId || "")) throw notFound("Agent not found");
  const { rows } = await query("SELECT id FROM agents WHERE id = $1 AND workspace_id = $2", [agentId, workspace.id]);
  if (!rows[0]) throw notFound("Agent not found");
  if (!workspace.products.includes("crm")) return { crm: false };
  const link = await linkOf(workspace);
  if (!link || link.ai.agentId !== agentId) return { crm: true, connected: false };
  const levels = levelsOf(link.ai, link.modules);
  const mine = (await agentsWithChannels(workspace.id)).find((a) => a.id === agentId);
  return {
    crm: true,
    connected: true,
    modules: ["booking", "store"].filter((m) => link.modules[m]).map((m) => ({ module: m, level: levels[m] })),
    channels: [...new Set(mine.channels.map((c) => c.type))].filter((type) => link.ai.channels[type]),
  };
}

/** GET /agent-link, mounted at /w/:wid/crm. Any member reads it; changing the link is a settings save (admins). */
export const crmRouter = Router({ mergeParams: true });
crmRouter.get("/agent-link", wrap(async (req, res) => res.json(await crmAgentLink(req.workspace))));

/** GET /agents/:aid/crm, mounted at /w/:wid with the agent's routes. */
export const agentRouter = Router({ mergeParams: true });
agentRouter.get("/agents/:aid/crm", wrap(async (req, res) => res.json(await agentCrmLink(req.workspace, req.params.aid))));
