import { query } from "../../core/db.js";
import { decrypt } from "../../core/secrets.js";
import { render } from "./template.js";
import { resolveInputs, modelInput } from "./definitions.js";
import { send, request, readResponse, stripTags } from "./requests.js";
import { refresh, connection, ensureServerContext } from "./connections.js";
import { safeOrigin, runInPage, ensureInPageContext } from "./in-page.js";
import { startProcedure } from "./procedures.js";

// ───── Tools for the answering model ─────

/**
 * The tools an agent may use for a customer on `channel`. In-page integrations act inside the
 * customer's own browser tab, so they exist only in the widget: on a messaging channel there is
 * no session to act in, and an agent must never offer an action it cannot carry out.
 */
export async function agentTools(agentId, channel = "widget") {
  const { rows } = await query(
    "SELECT * FROM integrations WHERE agent_id = $1 AND enabled AND ($2 = 'widget' OR mode <> 'in_page') ORDER BY created_at",
    [agentId, channel]
  );
  const where = String(channel).startsWith("telegram") ? "telegram" : "widget";
  return rows.flatMap((integration) => [
    ...(integration.tools || []).filter(tool => !Object.values(tool.bindings || {}).some(b => b.source === "step") && (!tool.channels || tool.channels.includes(where))).map((tool) => ({ integration, tool: { ...tool, modelInput: modelInput(tool) } })),
    ...(integration.procedures || []).map((p) => ({ integration, tool: { ...p, procedure: true } })),
  ]);
}

/** True when the agent has an enabled in-page integration (its tools run in the customer's browser). */
export async function agentHasInPageTools(agentId) {
  const { rowCount } = await query("SELECT 1 FROM integrations WHERE agent_id = $1 AND enabled AND mode = 'in_page' LIMIT 1", [agentId]);
  return rowCount > 0;
}

/**
 * Who the customer is, as Replybek knows it (never as the AI says): {{customer.name}}, and in a
 * Telegram chat {{customer.telegram_user_id}} and {{customer.telegram_username}}, which Telegram
 * itself vouches for. A website visitor never has a Telegram id here, whatever the page sends.
 */
async function customerOf(conversationId) {
  if (!conversationId) return {};
  const row = (await query("SELECT channel, visitor FROM conversations WHERE id = $1", [conversationId])).rows[0];
  if (!row) return {};
  const telegram = String(row.channel || "").startsWith("telegram") && row.visitor?.telegram_user_id ? String(row.visitor.telegram_user_id) : null;
  return { name: row.visitor?.name || null, channel: row.channel, telegram_user_id: telegram, telegram_username: telegram ? row.visitor?.telegram_username || null : null };
}

/** Calls one tool for the signed-in customer. Retries once with a refreshed token after a 401. */
export async function callTool(integration, tool, args, conn, conversationId = null) {
  const scope = { args, context: conn?.context || {}, customer: await customerOf(conversationId), now: new Date() };
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
  if (["api_key", "none"].includes(integration.auth?.type)) {
    const res = await send(integration, req);
    return res.ok ? { ok: true, result: readResponse(tool.response, res.data, scope) } : { error: "failed", status: res.status, message: `The system returned HTTP ${res.status}. Check authentication and the endpoint.` };
  }
  if (!conn) return { error: "signed_out", message: "Sign in again to continue." };
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
export async function runTool({ conversationId, integration, tool, args, inpageOrigin = null, steps = {} }) {
  if (tool.procedure) return startProcedure({ conversationId, integration, procedure: tool, args, inpageOrigin });
  if (!conversationId) return { output: { error: "test_context_required", message: "Use the integration test panel for actions. The Playground has no signed-in customer session." } };
  if (integration.mode === "in_page") return runToolInPage({ conversationId, integration, tool, args, inpageOrigin, steps });
  const conn = ["api_key", "none"].includes(integration.auth?.type) ? await ensureServerContext(integration, conversationId) : await connection(integration.id, conversationId);
  if (!conn) {
    return {
      output: { error: "not_signed_in", message: `The customer isn't signed in to ${integration.name}. A sign-in button is shown to them; ask them to sign in.` },
      card: { type: "connect", integration_id: integration.id, name: integration.name },
    };
  }
  try { args = resolveInputs(tool, args, conn.context || {}, steps); } catch (e) { return { output: { error: "invalid_inputs", message: e.message } }; }
  if (tool.kind === "write") {
    const scope = { args, context: conn.context || {}, customer: await customerOf(conversationId), now: new Date() };
    const summary = {
      title: render(tool.confirm?.title || tool.description, scope),
      lines: render(tool.confirm?.lines || [], scope).filter((l) => Array.isArray(l) && l[0]),
      total: tool.confirm?.total ? render(tool.confirm.total, scope) : null,
    };
    const { rows } = await query(
      "INSERT INTO pending_actions (conversation_id, integration_id, tool, args, summary, tool_snapshot, integration_revision) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      [conversationId, integration.id, tool.name, args, summary, tool, integration.config_revision]
    );
    return {
      output: { status: "waiting_for_customer", message: "A confirmation card is shown to the customer. Nothing has changed yet; tell them to check the details and press Confirm." },
      card: { type: "confirm", action_id: rows[0].id, integration_id: integration.id, name: integration.name, ...summary, status: "pending" },
    };
  }
  const out = await callTool(integration, tool, args, conn, conversationId);
  return { output: out.ok ? out.result : out };
}

/** In-page version of runTool: the browser runs reads now; writes still wait for Confirm. */
async function runToolInPage({ conversationId, integration, tool, args, inpageOrigin, steps = {} }) {
  if (!inpageOrigin || safeOrigin(integration.base_url) !== inpageOrigin) {
    return { output: { error: "not_in_app", message: `This only works inside ${integration.name}. Tell the customer to open the chat from within ${integration.name} and try again.` } };
  }
  const inputConn = await ensureInPageContext(integration, conversationId);
  try { args = resolveInputs(tool, args, inputConn?.context || {}, steps); } catch (e) { return { output: { error: "invalid_inputs", message: e.message } }; }
  if (tool.kind === "write") {
    const conn = await connection(integration.id, conversationId);
    const scope = { args, context: conn?.context || {}, now: new Date() };
    const summary = {
      title: render(tool.confirm?.title || tool.description, scope),
      lines: render(tool.confirm?.lines || [], scope).filter((l) => Array.isArray(l) && l[0]),
      total: tool.confirm?.total ? render(tool.confirm.total, scope) : null,
    };
    const { rows } = await query("INSERT INTO pending_actions (conversation_id, integration_id, tool, args, summary, tool_snapshot, integration_revision) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id", [conversationId, integration.id, tool.name, args, summary, tool, integration.config_revision]);
    return {
      output: { status: "waiting_for_customer", message: "A confirmation card is shown to the customer. Nothing has changed yet; tell them to check the details and press Confirm." },
      card: { type: "confirm", action_id: rows[0].id, integration_id: integration.id, name: integration.name, ...summary, status: "pending" },
    };
  }
  const conn = await connection(integration.id, conversationId);
  const out = await callTool(integration, tool, args, conn, conversationId);
  return { output: out.ok ? out.result : out };
}
