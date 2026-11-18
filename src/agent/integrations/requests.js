import { HttpError, notFound } from "../../core/http.js";
import { decrypt } from "../../core/secrets.js";
import { render, pick } from "./template.js";
import { assertPublicHost } from "../../core/safe-fetch.js";
import { resolveInputs } from "./definitions.js";
import { loadIntegration } from "./integrations.js";

export const TIMEOUT_MS = 15000;
const MAX_ROWS = 25;
const MAX_RESULT_BYTES = Number(process.env.TOOL_RESULT_MAX_BYTES || 16000); // keep a big system table from blowing the model's context

// ───── HTTP to the external system ─────
export async function guardHost(baseUrl) {
  // Local systems are fine while developing; production only talks to public hosts.
  if (process.env.NODE_ENV !== "production") return;
  await assertPublicHost(new URL(baseUrl).hostname);
}


export function absolute(integration, path) {
  if (/^https?:\/\//i.test(path)) {
    // Only the integration's own host: a tool can't be pointed somewhere else.
    if (new URL(path).origin !== new URL(integration.base_url).origin) throw new HttpError(400, "A tool can only call its integration's address.");
    return path;
  }
  return integration.base_url + (path.startsWith("/") ? path : `/${path}`);
}

export async function send(integration, { method = "POST", path, headers = {}, body }, accessToken) {
  const url = absolute(integration, path);
  if (new URL(url).username || new URL(url).password) throw new HttpError(400, "Put credentials in authentication settings, not the URL.");
  await guardHost(url);
  const credentialHeaders = integration.auth?.type === "api_key" ? { [integration.auth.header || "Authorization"]: (integration.auth.prefix ?? "Bearer ") + decrypt(integration.client_secret_enc) } : {};
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      ...(body !== undefined && method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...headers,
      ...credentialHeaders,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body !== undefined && method !== "GET" ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "manual",
  });
  const reader = res.body?.getReader();
  let size = 0; const chunks = [];
  if (reader) { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 1024 * 1024) { await reader.cancel(); throw new HttpError(502, "Response exceeds 1 MB. Request fewer records."); } chunks.push(Buffer.from(value)); } }
  const text = Buffer.concat(chunks).toString("utf8");
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Some systems answer with plain text; keep it as is.
  }
  return { status: res.status, ok: res.ok, data };
}

export const stripTags = (s) => String(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// Headers without a value (e.g. a context value not read yet) are left out, not sent as "null".
const cleanHeaders = (h) => Object.fromEntries(Object.entries(h).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(v)]));

/** Builds a request from a config block and the current scope (args, context, now). */
export function request(integration, block, scope) {
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
export function readResponse(spec = {}, data, scope) {
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
  let value = spec.pick ? pick(data, spec.pick) : data;
  if (spec.fields && Object.keys(spec.fields).length) {
    const map = (row) => Object.fromEntries(Object.entries(spec.fields).map(([name, path]) => [name, pick(row, path) ?? null]));
    value = Array.isArray(value) ? value.map(map) : map(value);
  }
  return capResult(value === undefined ? null : value);
}

/** Dry-run: the exact request a tool would send, given sample args and context. No execution, no network.
 *  `draft` ({ base_url, headers, tool }) lets the dashboard preview unsaved edits. */
export async function previewTool(workspaceId, integrationId, toolName, args = {}, context = {}, draft = {}) {
  const saved = await loadIntegration(workspaceId, integrationId);
  const tool = draft.tool && draft.tool.name === toolName ? draft.tool : (saved.tools || []).find((t) => t.name === toolName);
  if (!tool || !tool.request) throw notFound("Tool not found");
  const integration = { base_url: (draft.base_url || saved.base_url || "").replace(/\/$/, ""), headers: draft.headers || saved.headers || {} };
  const req = request(integration, tool.request, { args: resolveInputs(tool, args, context), context, now: new Date() });
  return { kind: tool.kind || "read", request: req };
}
