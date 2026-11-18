import { isDeepStrictEqual } from "node:util";
import { query } from "../../core/db.js";
import { HttpError, notFound } from "../../core/http.js";
import { encrypt } from "../../core/secrets.js";
import { logActivity } from "../../core/activity/activity.js";
import { integrationSchema } from "./checks.js";
import { validateDefinitions } from "./definitions.js";


/**
 * Integrations let an agent act in a business system (an ERP, a CRM, a shop) for the customer
 * who is chatting: look up their orders, prices, balances, or place an order after they confirm.
 *
 * Nothing here knows about a particular system. An integration is configuration:
 *   - auth: an OAuth 2 authorization-code client. The customer signs in on the system's own page;
 *     Replybek only receives a token for that conversation and never sees a password.
 *   - context: values read once after sign-in (an account id, a branch) for later requests.
 *   - tools: what the agent may do. Each says how to build the HTTP request and read the answer.
 */

// ───── Admin: configuration ─────
const shape = (row) => ({
  id: row.id,
  agent_id: row.agent_id,
  name: row.name,
  mode: row.mode,
  base_url: row.base_url,
  auth: row.auth,
  has_client_secret: Boolean(row.client_secret_enc),
  headers: row.headers,
  context: row.context,
  account: row.account,
  tools: row.tools,
  procedures: row.procedures || [],
  last_test: row.last_test,
  readiness: !row.tools?.length ? "needs_actions" : !row.last_test?.ok ? "needs_test" : row.last_test.mode === "mock" ? "simulated" : "tested",
  enabled: row.enabled,
  connections: Number(row.connections || 0),
  created_at: row.created_at,
  updated_at: row.updated_at,
});

export async function listIntegrations(workspaceId) {
  const { rows } = await query(
    `SELECT i.*, (SELECT count(*) FROM integration_connections c WHERE c.integration_id = i.id) AS connections
       FROM integrations i WHERE i.workspace_id = $1 ORDER BY i.created_at`,
    [workspaceId]
  );
  return rows.map(shape);
}

export async function loadIntegration(workspaceId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(id || "")) throw notFound("Integration not found");
  const { rows } = await query("SELECT * FROM integrations WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
  if (!rows[0]) throw notFound("Integration not found");
  return rows[0];
}

function checkTools(tools) {
  const names = new Set();
  for (const t of tools) {
    if (names.has(t.name)) throw new HttpError(400, `Two tools are named “${t.name}”. Tool names must be unique.`);
    names.add(t.name);
  }
}

export async function createIntegration(workspace, user, input) {
  input = integrationSchema.parse(input);
  validateDefinitions(input);
  if (input.auth?.type === "api_key" && !input.client_secret) throw new HttpError(400, "Add an API key.");
  const { rows: agents } = await query("SELECT id FROM agents WHERE id = $1 AND workspace_id = $2", [input.agent_id, workspace.id]);
  if (!agents[0]) throw notFound("Agent not found");
  await checkAgentNames(input.agent_id, input);
  const { rows } = await query(
    `INSERT INTO integrations (workspace_id, agent_id, name, mode, base_url, auth, client_secret_enc, headers, context, account, tools, enabled, procedures)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
    [workspace.id, input.agent_id, input.name, input.mode, input.base_url.replace(/\/$/, ""), input.auth, encrypt(input.client_secret), input.headers, JSON.stringify(input.context), input.account, JSON.stringify(input.tools), input.enabled, JSON.stringify(input.procedures)]
  );
  await logActivity(workspace.id, user.id, "{actor} added the integration “{name}”", { actor: user.name, name: input.name });
  return shape(rows[0]);
}

export async function updateIntegration(workspaceId, id, input) {
  const current = await loadIntegration(workspaceId, id);
  if (input.tools) checkTools(input.tools);
  const parsed = integrationSchema.safeParse({ ...current, ...input });
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map(x => x.message).join("; "));
  const next = parsed.data;
  validateDefinitions(next);
  if (next.auth?.type === "api_key" && !(input.client_secret || (current.auth?.type === "api_key" && current.client_secret_enc))) throw new HttpError(400, "Add an API key.");
  await checkAgentNames(current.agent_id, next, id);
  const keys = ["mode", "base_url", "auth", "headers", "context", "account", "tools", "procedures"];
  const normalizedCurrent = integrationSchema.parse(current);
  const changed = !!input.client_secret || keys.some(k => !isDeepStrictEqual(next[k], normalizedCurrent[k]));
  const { rows } = await query(
    `UPDATE integrations SET name = $3, mode = $4, base_url = $5, auth = $6, client_secret_enc = $7, headers = $8, context = $9, account = $10,
            tools = $11, enabled = $12, procedures = $13, last_test = CASE WHEN $14 THEN NULL ELSE last_test END, config_revision = config_revision + CASE WHEN $14 THEN 1 ELSE 0 END, updated_at = now()
      WHERE id = $1 AND workspace_id = $2 RETURNING *`,
    [
      id,
      workspaceId,
      next.name,
      next.mode,
      next.base_url.replace(/\/$/, ""),
      next.auth,
      input.client_secret ? encrypt(input.client_secret) : current.client_secret_enc,
      next.headers,
      JSON.stringify(next.context),
      next.account,
      JSON.stringify(next.tools),
      next.enabled,
      JSON.stringify(next.procedures),
      changed,
    ]
  );
  if (!!input.client_secret || ["mode", "base_url", "auth", "headers", "context", "account"].some(k => !isDeepStrictEqual(next[k], normalizedCurrent[k]))) {
    await query("DELETE FROM integration_connections WHERE integration_id=$1",[id]);
  }
  return shape(rows[0]);
}

export async function deleteIntegration(workspaceId, id, user) {
  const current = await loadIntegration(workspaceId, id);
  await query("DELETE FROM integrations WHERE id = $1", [id]);
  await logActivity(workspaceId, user.id, "{actor} removed the integration “{name}”", { actor: user.name, name: current.name });
}

async function checkAgentNames(agentId, config, exclude = null) {
  const existing = (await query("SELECT tools, procedures FROM integrations WHERE agent_id = $1 AND ($2::uuid IS NULL OR id <> $2)", [agentId, exclude])).rows;
  const names = new Set(existing.flatMap(i => [...(i.tools || []), ...(i.procedures || [])].map(t => t.name)));
  for (const t of [...config.tools, ...config.procedures]) if (names.has(t.name)) throw new HttpError(400, `An action named ${t.name} already belongs to this agent. Choose a unique name.`);
}
