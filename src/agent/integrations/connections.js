import { query } from "../../core/db.js";
import { HttpError, notFound } from "../../core/http.js";
import { encrypt, decrypt, sign, verify } from "../../core/secrets.js";
import { pick } from "./template.js";
import { TIMEOUT_MS, guardHost, absolute, send, request } from "./requests.js";

const PUBLIC_API_URL = () => (process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 3100}`).replace(/\/$/, "");

// ───── Customers' sign-in (OAuth 2 authorization code) ─────
export const redirectUri = () => `${PUBLIC_API_URL()}/oauth/callback`;

/** Where the widget sends the customer to sign in. The state proves who asked, for 10 minutes. */
export async function connectUrl(agent, conversationId, integrationId) {
  const { rows } = await query("SELECT * FROM integrations WHERE id = $1 AND agent_id = $2 AND enabled", [integrationId, agent.id]);
  const integration = rows[0];
  if (!integration || integration.mode !== "server" || ["api_key", "none"].includes(integration.auth?.type)) throw notFound("This connection isn't available.");
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

export async function refresh(integration, connection) {
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

export async function connectionsFor(conversationId) {
  if (!conversationId) return [];
  const { rows } = await query(
    "SELECT c.integration_id, c.account_label, i.name FROM integration_connections c JOIN integrations i ON i.id = c.integration_id WHERE c.conversation_id = $1",
    [conversationId]
  );
  return rows;
}

export async function connection(integrationId, conversationId) {
  if (!conversationId) return null;
  const { rows } = await query("SELECT * FROM integration_connections WHERE integration_id = $1 AND conversation_id = $2", [integrationId, conversationId]);
  return rows[0] || null;
}

export async function ensureServerContext(integration, conversationId) {
  let conn = await connection(integration.id, conversationId); if (conn) return conn;
  const context = {};
  for (const step of integration.context || []) {
    const res = await send(integration, request(integration, step.request, { context, now: new Date() }));
    if (!res.ok) throw new HttpError(502, `Unable to load account context (HTTP ${res.status}).`);
    context[step.name] = pick(res.data, step.pick) ?? null;
  }
  await query("INSERT INTO integration_connections (integration_id, conversation_id, context) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [integration.id, conversationId, context]);
  return connection(integration.id, conversationId);
}
