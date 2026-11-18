import { query } from "../../core/db.js";
import { pick } from "./template.js";
import { request } from "./requests.js";
import { connection } from "./connections.js";
import * as bridge from "./bridge.js";

// ───── In-page execution: the widget runs the request in the system's own tab ─────

export const safeOrigin = (url) => { try { return new URL(url).origin; } catch { return null; } };

/** Hands one rendered request to the browser and waits for the result (or a timeout). */
export async function runInPage(integrationId, conversationId, rendered) {
  const integration = (await query("SELECT auth FROM integrations WHERE id=$1", [integrationId])).rows[0];
  if (integration?.auth?.browser_auth === "host_token") rendered = { ...rendered, browser_auth: { provider: "host_token", header: integration.auth.header || "Authorization", prefix: integration.auth.prefix ?? "Bearer " } };
  const { rows } = await query("INSERT INTO tool_calls (conversation_id, integration_id, request) VALUES ($1, $2, $3) RETURNING id", [conversationId, integrationId, rendered]);
  const res = await bridge.wait(rows[0].id);
  if (res.timedOut) {
    await query("UPDATE tool_calls SET status = 'done', response = $2 WHERE id = $1 AND status = 'pending'", [rows[0].id, { status: 0, body: null }]);
    return { timedOut: true };
  }
  return { status: res.status, data: res.body };
}

/** For in-page: reads the account's context (ids, branch) and name through the browser, once per conversation. */
export async function ensureInPageContext(integration, conversationId) {
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
