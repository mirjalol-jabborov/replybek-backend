import { query } from "../db.js";
import { notFound } from "../lib/http.js";
import { logActivity } from "./activity.service.js";
import { assertRoomFor } from "./workspaces.service.js";

const FIELDS = ["name", "purpose", "instructions", "tone", "welcome", "fallback", "handoff", "allowed_origins", "suggested_questions", "suggested_questions_i18n", "suggestion_default_language", "welcome_i18n"];

export async function listAgents(workspaceId) {
  const { rows } = await query(
    `SELECT a.*,
            (SELECT count(*)::int FROM sources s WHERE s.agent_id = a.id) AS source_count,
            (SELECT count(*)::int FROM sources s WHERE s.agent_id = a.id AND s.status = 'error') AS source_errors,
            (SELECT count(*)::int FROM conversations c WHERE c.agent_id = a.id AND c.created_at > now() - interval '30 days') AS conversations_30d
       FROM agents a WHERE a.workspace_id = $1 ORDER BY a.created_at`,
    [workspaceId]
  );
  return rows;
}

/** The agent with its workspace's name (the answer prompt needs it). Scoped to the workspace. */
export async function getAgent(workspaceId, agentId) {
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) throw notFound("Agent not found");
  const { rows } = await query(
    "SELECT a.*, w.name AS workspace_name FROM agents a JOIN workspaces w ON w.id = a.workspace_id WHERE a.id = $1 AND a.workspace_id = $2",
    [agentId, workspaceId]
  );
  if (!rows[0]) throw notFound("Agent not found");
  return rows[0];
}

export async function createAgent(workspace, user, input) {
  await assertRoomFor(workspace.id, "agents");
  const business = workspace.name;
  const { rows } = await query(
    `INSERT INTO agents (workspace_id, name, purpose, instructions, tone, welcome, fallback, handoff)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      workspace.id,
      input.name,
      input.purpose,
      input.instructions ?? `You are ${input.name}, the AI agent for ${business}.\n- ${input.purpose || "Answer customer questions."}\n- Answer only from your knowledge sources.\n- If you're unsure, offer to connect the customer with the team.`,
      input.tone,
      input.welcome ?? `Hi! I'm ${input.name} from ${business}. How can I help?`,
      input.fallback ?? `I don't have a confident answer to that yet. I can pass your question to the ${business} team.`,
      input.handoff,
    ]
  );
  await logActivity(workspace.id, user.id, "{actor} created {name}", { actor: user.name, name: input.name }, { key: "Draft" });
  return rows[0];
}

export async function updateAgent(workspaceId, agentId, input) {
  await getAgent(workspaceId, agentId);
  const sets = [];
  const values = [agentId, workspaceId];
  for (const f of FIELDS) {
    if (input[f] !== undefined) {
      values.push(["suggested_questions", "suggested_questions_i18n", "welcome_i18n"].includes(f) ? JSON.stringify(input[f]) : input[f]);
      sets.push(`${f} = $${values.length}`);
    }
  }
  if (input.widget) {
    values.push(input.widget);
    sets.push(`widget = widget || $${values.length}::jsonb`);
  }
  if (sets.length) await query(`UPDATE agents SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND workspace_id = $2`, values);
  return getAgent(workspaceId, agentId);
}

export async function setAgentStatus(workspaceId, agentId, status, user) {
  const agent = await getAgent(workspaceId, agentId);
  await query("UPDATE agents SET status = $3, updated_at = now() WHERE id = $1 AND workspace_id = $2", [agentId, workspaceId, status]);
  await logActivity(workspaceId, user.id, status === "active" ? "{actor} published {name}" : "{actor} unpublished {name}", { actor: user.name, name: agent.name });
  return getAgent(workspaceId, agentId);
}

export async function deleteAgent(workspaceId, agentId, user) {
  const agent = await getAgent(workspaceId, agentId);
  await query("DELETE FROM agents WHERE id = $1 AND workspace_id = $2", [agentId, workspaceId]);
  await logActivity(workspaceId, user.id, "{actor} deleted {name}", { actor: user.name, name: agent.name });
}
