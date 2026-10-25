import { query } from "../db.js";
import { HttpError, notFound } from "../lib/http.js";
import { encrypt, decrypt, sign, verify } from "../lib/secrets.js";
import { render, pick } from "../lib/template.js";
import { assertPublicHost } from "../lib/safeFetch.js";
import { logActivity } from "./activity.service.js";
import * as bridge from "../lib/bridge.js";

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

const TIMEOUT_MS = 15000;
const MAX_ROWS = 25;
const MAX_RESULT_BYTES = Number(process.env.TOOL_RESULT_MAX_BYTES || 16000); // keep a big system table from blowing the model's context
const PUBLIC_API_URL = () => (process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 3100}`).replace(/\/$/, "");

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

async function loadIntegration(workspaceId, id) {
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
  checkTools(input.tools);
  const { rows: agents } = await query("SELECT id FROM agents WHERE id = $1 AND workspace_id = $2", [input.agent_id, workspace.id]);
  if (!agents[0]) throw notFound("Agent not found");
  const { rows } = await query(
    `INSERT INTO integrations (workspace_id, agent_id, name, mode, base_url, auth, client_secret_enc, headers, context, account, tools, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [workspace.id, input.agent_id, input.name, input.mode, input.base_url.replace(/\/$/, ""), input.auth, encrypt(input.client_secret), input.headers, JSON.stringify(input.context), input.account, JSON.stringify(input.tools), input.enabled]
  );
  await logActivity(workspace.id, user.id, "{actor} added the integration “{name}”", { actor: user.name, name: input.name });
  return shape(rows[0]);
}

export async function updateIntegration(workspaceId, id, input) {
  const current = await loadIntegration(workspaceId, id);
  if (input.tools) checkTools(input.tools);
  const next = { ...current, ...input };
  const { rows } = await query(
    `UPDATE integrations SET name = $3, mode = $4, base_url = $5, auth = $6, client_secret_enc = $7, headers = $8, context = $9, account = $10,
            tools = $11, enabled = $12, updated_at = now()
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
    ]
  );
  return shape(rows[0]);
}

export async function deleteIntegration(workspaceId, id, user) {
  const current = await loadIntegration(workspaceId, id);
  await query("DELETE FROM integrations WHERE id = $1", [id]);
  await logActivity(workspaceId, user.id, "{actor} removed the integration “{name}”", { actor: user.name, name: current.name });
}

// ───── HTTP to the external system ─────
async function guardHost(baseUrl) {
  // Local systems are fine while developing; production only talks to public hosts.
  if (process.env.NODE_ENV !== "production") return;
  await assertPublicHost(new URL(baseUrl).hostname);
}

const safeOrigin = (url) => { try { return new URL(url).origin; } catch { return null; } };

function absolute(integration, path) {
  if (/^https?:\/\//i.test(path)) {
    // Only the integration's own host: a tool can't be pointed somewhere else.
    if (new URL(path).origin !== new URL(integration.base_url).origin) throw new HttpError(400, "A tool can only call its integration's address.");
    return path;
  }
  return integration.base_url + (path.startsWith("/") ? path : `/${path}`);
}

async function send(integration, { method = "POST", path, headers = {}, body }, accessToken) {
  const url = absolute(integration, path);
  await guardHost(url);
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      ...(body !== undefined && method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...headers,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body !== undefined && method !== "GET" ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "manual",
  });
  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Some systems answer with plain text; keep it as is.
  }
  return { status: res.status, ok: res.ok, data };
}

const stripTags = (s) => String(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// Headers without a value (e.g. a context value not read yet) are left out, not sent as "null".
const cleanHeaders = (h) => Object.fromEntries(Object.entries(h).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(v)]));

/** Builds a request from a config block and the current scope (args, context, now). */
function request(integration, block, scope) {
  return {
    method: (block.method || "POST").toUpperCase(),
    path: render(block.path, scope),
    headers: cleanHeaders({ ...render(integration.headers || {}, scope), ...render(block.headers || {}, scope) }),
    body: block.body === undefined ? undefined : render(block.body, scope),
  };
}

/** Trims a tool result that's too big, so it never floods the model's context (like Chatbase's 20KB cap). */
function capResult(result) {
  if (result == null) return result;
  let json;
  try { json = JSON.stringify(result); } catch { return result; }
  if (!json || json.length <= MAX_RESULT_BYTES) return result;
  if (Array.isArray(result.rows)) {
    let rows = result.rows;
    while (rows.length > 1 && JSON.stringify({ ...result, rows }).length > MAX_RESULT_BYTES) rows = rows.slice(0, Math.max(1, Math.floor(rows.length / 2)));
    return { ...result, rows, truncated: true, note: `Showing ${rows.length} of ${result.total ?? rows.length}. The result was too large; narrow it with a filter or fewer columns.` };
  }
  return { error: "too_large", message: `The result is too large (over ${Math.round(MAX_RESULT_BYTES / 1000)}KB). Ask for fewer fields, add a filter, or a smaller limit.` };
}

/** Reads a tool's answer: a table (column names + row arrays), or a JSON value. */
function readResponse(spec = {}, data, scope) {
  if (spec.type === "rows") {
    const columns = render(spec.columns, scope);
    let rows = (pick(data, spec.rows || "data") || []).map((r) => (Array.isArray(r) ? Object.fromEntries(columns.map((c, i) => [c, r[i]])) : r));
    for (const f of spec.filter || []) {
      // Filters with an empty value (the model didn't pass that argument) are skipped.
      const want = render(f.equals ?? f.contains, scope);
      if (want == null || want === "") continue;
      rows = f.equals !== undefined ? rows.filter((r) => String(r[f.field]) === String(want)) : rows.filter((r) => String(r[f.field] ?? "").toLowerCase().includes(String(want).toLowerCase()));
    }
    const total = pick(data, spec.count || "count");
    return capResult({ rows: rows.slice(0, spec.limit || MAX_ROWS), total: total == null ? rows.length : Number(total) });
  }
  const value = spec.pick ? pick(data, spec.pick) : data;
  return capResult(value === undefined ? null : value);
}

/** Dry-run: the exact request a tool would send, given sample args and context. No execution, no network.
 *  `draft` ({ base_url, headers, tool }) lets the dashboard preview unsaved edits. */
export async function previewTool(workspaceId, integrationId, toolName, args = {}, context = {}, draft = {}) {
  const saved = await loadIntegration(workspaceId, integrationId);
  const tool = draft.tool && draft.tool.name === toolName ? draft.tool : (saved.tools || []).find((t) => t.name === toolName);
  if (!tool || !tool.request) throw notFound("Tool not found");
  const integration = { base_url: (draft.base_url || saved.base_url || "").replace(/\/$/, ""), headers: draft.headers || saved.headers || {} };
  const req = request(integration, tool.request, { args, context, now: new Date() });
  return { kind: tool.kind || "read", request: req };
}

// ───── Customers' sign-in (OAuth 2 authorization code) ─────
export const redirectUri = () => `${PUBLIC_API_URL()}/oauth/callback`;

/** Where the widget sends the customer to sign in. The state proves who asked, for 10 minutes. */
export async function connectUrl(agent, conversationId, integrationId) {
  const { rows } = await query("SELECT * FROM integrations WHERE id = $1 AND agent_id = $2 AND enabled", [integrationId, agent.id]);
  const integration = rows[0];
  if (!integration) throw notFound("This connection isn't available.");
  const a = integration.auth || {};
  const url = new URL(absolute(integration, a.authorize_url));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", a.client_id);
  url.searchParams.set("redirect_uri", redirectUri());
  if (a.scope) url.searchParams.set("scope", a.scope);
  url.searchParams.set("state", sign({ i: integration.id, c: conversationId }));
  return { url: url.toString(), name: integration.name };
}

async function exchangeCode(integration, code) {
  const a = integration.auth || {};
  const fields = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    client_id: a.client_id,
    client_secret: decrypt(integration.client_secret_enc),
  };
  const url = absolute(integration, a.token_url);
  await guardHost(url);
  const json = a.token_format === "json";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": json ? "application/json" : "application/x-www-form-urlencoded", Accept: "application/json" },
    body: json ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new HttpError(502, data.error_description || data.error || "The sign-in couldn't be completed.");
  return data;
}

async function refresh(integration, connection) {
  const a = integration.auth || {};
  const refreshToken = decrypt(connection.refresh_token_enc);
  if (!refreshToken) return null;
  const fields = { grant_type: "refresh_token", refresh_token: refreshToken, client_id: a.client_id, client_secret: decrypt(integration.client_secret_enc) };
  const json = a.token_format === "json";
  const res = await fetch(absolute(integration, a.token_url), {
    method: "POST",
    headers: { "Content-Type": json ? "application/json" : "application/x-www-form-urlencoded", Accept: "application/json" },
    body: json ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  const data = res && (await res.json().catch(() => ({})));
  if (!res?.ok || !data.access_token) return null;
  await query("UPDATE integration_connections SET access_token_enc = $2, refresh_token_enc = COALESCE($3, refresh_token_enc), expires_at = $4 WHERE id = $1", [
    connection.id,
    encrypt(data.access_token),
    data.refresh_token ? encrypt(data.refresh_token) : null,
    data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000) : null,
  ]);
  return data.access_token;
}

/**
 * The page the sign-in returns to. Saves the token for that conversation, reads the account's
 * context values and its display name, and returns what the widget should say.
 */
export async function completeConnect({ code, state, error }) {
  const s = verify(state);
  if (!s) throw new HttpError(400, "This sign-in link expired. Start again from the chat.");
  if (error || !code) throw new HttpError(400, "The sign-in was cancelled.");
  const { rows } = await query(
    "SELECT i.*, c.id AS conversation_id FROM integrations i JOIN conversations c ON c.id = $2 AND c.agent_id = i.agent_id WHERE i.id = $1",
    [s.i, s.c]
  );
  const integration = rows[0];
  if (!integration) throw notFound("This connection isn't available.");
  const tokens = await exchangeCode(integration, code);

  const context = {};
  for (const step of integration.context || []) {
    const res = await send(integration, request(integration, step.request, { context, now: new Date() }), tokens.access_token);
    if (res.ok) context[step.name] = pick(res.data, step.pick) ?? null;
  }
  let label = null;
  if (integration.account?.request) {
    const res = await send(integration, request(integration, integration.account.request, { context }), tokens.access_token);
    if (res.ok) label = String(pick(res.data, integration.account.pick) ?? "").slice(0, 120) || null;
  }
  await query(
    `INSERT INTO integration_connections (integration_id, conversation_id, account_label, context, access_token_enc, refresh_token_enc, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (integration_id, conversation_id) DO UPDATE SET account_label = EXCLUDED.account_label, context = EXCLUDED.context,
       access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc, expires_at = EXCLUDED.expires_at`,
    [
      integration.id,
      integration.conversation_id,
      label,
      context,
      encrypt(tokens.access_token),
      tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      tokens.expires_in ? new Date(Date.now() + Number(tokens.expires_in) * 1000) : null,
    ]
  );
  return { conversationId: integration.conversation_id, integration, label };
}

export async function disconnect(conversationId, integrationId) {
  await query("DELETE FROM integration_connections WHERE conversation_id = $1 AND integration_id = $2", [conversationId, integrationId]);
}

// ───── In-page execution: the widget runs the request in the system's own tab ─────

/** Hands one rendered request to the browser and waits for the result (or a timeout). */
async function runInPage(integrationId, conversationId, rendered) {
  const { rows } = await query("INSERT INTO tool_calls (conversation_id, integration_id, request) VALUES ($1, $2, $3) RETURNING id", [conversationId, integrationId, rendered]);
  const res = await bridge.wait(rows[0].id);
  if (res.timedOut) {
    await query("UPDATE tool_calls SET status = 'done', response = $2 WHERE id = $1 AND status = 'pending'", [rows[0].id, { status: 0, body: null }]);
    return { timedOut: true };
  }
  return { status: res.status, data: res.body };
}

/** For in-page: reads the account's context (ids, branch) and name through the browser, once per conversation. */
async function ensureInPageContext(integration, conversationId) {
  let conn = await connection(integration.id, conversationId);
  if (conn && conn.context && Object.keys(conn.context).length) return conn;
  const context = {};
  for (const step of integration.context || []) {
    const res = await runInPage(integration.id, conversationId, request(integration, step.request, { context, now: new Date() }));
    if (!res.timedOut && res.data != null) context[step.name] = pick(res.data, step.pick) ?? null;
  }
  let label = null;
  if (integration.account?.request) {
    const res = await runInPage(integration.id, conversationId, request(integration, integration.account.request, { context, now: new Date() }));
    if (!res.timedOut && res.data != null) label = String(pick(res.data, integration.account.pick) ?? "").slice(0, 120) || null;
  }
  await query(
    `INSERT INTO integration_connections (integration_id, conversation_id, account_label, context, access_token_enc)
     VALUES ($1, $2, $3, $4, NULL)
     ON CONFLICT (integration_id, conversation_id) DO UPDATE SET account_label = EXCLUDED.account_label, context = EXCLUDED.context`,
    [integration.id, conversationId, label, context]
  );
  return connection(integration.id, conversationId);
}

/** The pending requests the widget should run now, and delivering a result back to the waiter. */
export async function pendingToolCalls(conversationId) {
  const { rows } = await query("SELECT id, integration_id, request FROM tool_calls WHERE conversation_id = $1 AND status = 'pending' ORDER BY created_at", [conversationId]);
  return rows;
}
export async function deliverToolResult(conversationId, toolCallId, result) {
  if (!/^[0-9a-f-]{36}$/i.test(toolCallId || "")) return;
  const { rowCount } = await query("UPDATE tool_calls SET status = 'done', response = $3 WHERE id = $1 AND conversation_id = $2 AND status = 'pending'", [toolCallId, conversationId, result]);
  if (rowCount) bridge.deliver(toolCallId, result);
}

// ───── Tools for the answering model ─────

/** The enabled tools of an agent, each with its integration. */
export async function agentTools(agentId) {
  const { rows } = await query("SELECT * FROM integrations WHERE agent_id = $1 AND enabled ORDER BY created_at", [agentId]);
  return rows.flatMap((integration) => (integration.tools || []).map((tool) => ({ integration, tool })));
}

/** True when the agent has an enabled in-page integration (its tools run in the customer's browser). */
export async function agentHasInPageTools(agentId) {
  const { rowCount } = await query("SELECT 1 FROM integrations WHERE agent_id = $1 AND enabled AND mode = 'in_page' LIMIT 1", [agentId]);
  return rowCount > 0;
}

/** The integration mode behind a pending action ('server' | 'in_page'), or null. */
export async function actionIntegrationMode(conversationId, actionId) {
  if (!/^[0-9a-f-]{36}$/i.test(actionId || "")) return null;
  const { rows } = await query("SELECT i.mode FROM pending_actions a JOIN integrations i ON i.id = a.integration_id WHERE a.id = $1 AND a.conversation_id = $2", [actionId, conversationId]);
  return rows[0]?.mode || null;
}

export async function connectionsFor(conversationId) {
  if (!conversationId) return [];
  const { rows } = await query(
    "SELECT c.integration_id, c.account_label, i.name FROM integration_connections c JOIN integrations i ON i.id = c.integration_id WHERE c.conversation_id = $1",
    [conversationId]
  );
  return rows;
}

async function connection(integrationId, conversationId) {
  if (!conversationId) return null;
  const { rows } = await query("SELECT * FROM integration_connections WHERE integration_id = $1 AND conversation_id = $2", [integrationId, conversationId]);
  return rows[0] || null;
}

/** Calls one tool for the signed-in customer. Retries once with a refreshed token after a 401. */
export async function callTool(integration, tool, args, conn, conversationId = null) {
  const scope = { args, context: conn?.context || {}, now: new Date() };
  const req = request(integration, tool.request, scope);
  // A generic tool restricts which endpoints the model may reach (e.g. read-only ones).
  if (tool.request.allow) {
    let ok = false;
    try { ok = new RegExp(tool.request.allow).test(req.path); } catch { ok = false; }
    if (!ok) return { error: "not_allowed", message: `That endpoint isn't permitted by this tool. Use a path that this tool allows.` };
  }
  if (integration.mode === "in_page") {
    const res = await runInPage(integration.id, conversationId, req);
    if (res.timedOut) return { error: "failed", message: "The request to the system didn't finish. Ask the customer to keep the system's tab open and try again." };
    if (res.status === 401 || res.status === 403) return { error: "signed_out", message: "The customer isn't signed in to the system in this tab anymore." };
    if (!(res.status >= 200 && res.status < 300)) {
      const msg = typeof res.data === "string" ? stripTags(res.data) : res.data?.message || res.data?.error_description || res.data?.error;
      return { error: "failed", status: res.status, message: String(msg || `The system answered with status ${res.status}.`).slice(0, 300) };
    }
    return { ok: true, result: readResponse(tool.response, res.data, scope) };
  }
  let token = decrypt(conn.access_token_enc);
  if (conn.expires_at && new Date(conn.expires_at) < new Date(Date.now() + 30000)) token = (await refresh(integration, conn)) || token;
  let res = await send(integration, req, token);
  if (res.status === 401) {
    const fresh = await refresh(integration, conn);
    if (!fresh) return { error: "signed_out", message: "The customer's sign-in expired. Ask them to sign in again." };
    res = await send(integration, req, fresh);
  }
  if (!res.ok) {
    const message = typeof res.data === "string" ? stripTags(res.data) : res.data?.message || res.data?.error_description || res.data?.error;
    return { error: "failed", status: res.status, message: String(message || `The system answered with status ${res.status}.`).slice(0, 300) };
  }
  return { ok: true, result: readResponse(tool.response, res.data, scope) };
}

/**
 * Runs a tool the model asked for, in a conversation. Reads run now. Changes are saved as a
 * pending action and run only when the customer presses Confirm.
 * Returns { output (for the model), card? (for the customer) }.
 */
export async function runTool({ conversationId, integration, tool, args, inpageOrigin = null }) {
  if (integration.mode === "in_page") return runToolInPage({ conversationId, integration, tool, args, inpageOrigin });
  const conn = await connection(integration.id, conversationId);
  if (!conn) {
    return {
      output: { error: "not_signed_in", message: `The customer isn't signed in to ${integration.name}. A sign-in button is shown to them; ask them to sign in.` },
      card: { type: "connect", integration_id: integration.id, name: integration.name },
    };
  }
  if (tool.kind === "write") {
    const scope = { args, context: conn.context || {}, now: new Date() };
    const summary = {
      title: render(tool.confirm?.title || tool.description, scope),
      lines: render(tool.confirm?.lines || [], scope).filter((l) => Array.isArray(l) && l[0]),
      total: tool.confirm?.total ? render(tool.confirm.total, scope) : null,
    };
    const { rows } = await query(
      "INSERT INTO pending_actions (conversation_id, integration_id, tool, args, summary) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [conversationId, integration.id, tool.name, args, summary]
    );
    return {
      output: { status: "waiting_for_customer", message: "A confirmation card is shown to the customer. Nothing has changed yet; tell them to check the details and press Confirm." },
      card: { type: "confirm", action_id: rows[0].id, integration_id: integration.id, name: integration.name, ...summary, status: "pending" },
    };
  }
  const out = await callTool(integration, tool, args, conn);
  return { output: out.ok ? out.result : out };
}

/** In-page version of runTool: the browser runs reads now; writes still wait for Confirm. */
async function runToolInPage({ conversationId, integration, tool, args, inpageOrigin }) {
  if (!inpageOrigin || safeOrigin(integration.base_url) !== inpageOrigin) {
    return { output: { error: "not_in_app", message: `This only works inside ${integration.name}. Tell the customer to open the chat from within ${integration.name} and try again.` } };
  }
  await ensureInPageContext(integration, conversationId);
  if (tool.kind === "write") {
    const conn = await connection(integration.id, conversationId);
    const scope = { args, context: conn?.context || {}, now: new Date() };
    const summary = {
      title: render(tool.confirm?.title || tool.description, scope),
      lines: render(tool.confirm?.lines || [], scope).filter((l) => Array.isArray(l) && l[0]),
      total: tool.confirm?.total ? render(tool.confirm.total, scope) : null,
    };
    const { rows } = await query("INSERT INTO pending_actions (conversation_id, integration_id, tool, args, summary) VALUES ($1, $2, $3, $4, $5) RETURNING id", [conversationId, integration.id, tool.name, args, summary]);
    return {
      output: { status: "waiting_for_customer", message: "A confirmation card is shown to the customer. Nothing has changed yet; tell them to check the details and press Confirm." },
      card: { type: "confirm", action_id: rows[0].id, integration_id: integration.id, name: integration.name, ...summary, status: "pending" },
    };
  }
  const conn = await connection(integration.id, conversationId);
  const out = await callTool(integration, tool, args, conn, conversationId);
  return { output: out.ok ? out.result : out };
}

/** The customer pressed Confirm or Cancel on a pending action. */
export async function decideAction(conversationId, actionId, confirm, inpageOrigin = null) {
  if (!/^[0-9a-f-]{36}$/i.test(actionId || "")) throw notFound("Action not found");
  const { rows } = await query(
    "SELECT a.*, i.* , a.id AS action_id, a.status AS action_status FROM pending_actions a JOIN integrations i ON i.id = a.integration_id WHERE a.id = $1 AND a.conversation_id = $2",
    [actionId, conversationId]
  );
  const row = rows[0];
  if (!row) throw notFound("Action not found");
  if (row.action_status !== "pending") throw new HttpError(409, "This request was already handled.");
  if (!confirm) {
    await query("UPDATE pending_actions SET status = 'cancelled', decided_at = now() WHERE id = $1", [actionId]);
    return { status: "cancelled", name: row.name, summary: row.summary, integration_id: row.integration_id };
  }
  const tool = (row.tools || []).find((t) => t.name === row.tool && t.kind === "write");
  const conn = await connection(row.integration_id, conversationId);
  const integration = { ...row, id: row.integration_id };
  const out = !tool ? { error: "failed", message: "This action is no longer available." } : (!conn && integration.mode !== "in_page") ? { error: "signed_out", message: "Sign in again to continue." } : await callTool(integration, tool, row.args, conn, conversationId);
  const status = out.ok ? "done" : "failed";
  await query("UPDATE pending_actions SET status = $2, result = $3, decided_at = now() WHERE id = $1", [actionId, status, out]);
  return { status, name: row.name, summary: row.summary, integration_id: row.integration_id, result: out.ok ? out.result : null, error: out.ok ? null : out.message };
}
