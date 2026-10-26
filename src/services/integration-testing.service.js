import { query } from "../db.js";
import { HttpError, notFound } from "../lib/http.js";
import { sign, verify, decrypt } from "../lib/secrets.js";
import { resolveInputs } from "../lib/integration-config.js";
import {
  loadIntegration,
  request,
  readResponse,
  send,
} from "./integrations.service.js";

const identical = (a, b) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
function safeResult(value, secrets) {
  let json = JSON.stringify(value);
  for (const secret of secrets.filter(Boolean))
    json = json.split(JSON.stringify(secret).slice(1, -1)).join("[redacted]");
  return JSON.parse(json);
}
function readOnly(tool) {
  if (tool.kind !== "read" || tool.request.method !== "GET")
    throw new HttpError(
      400,
      "Live tests support GET read actions only. Use a mock response for POST actions and writes.",
    );
}
function withinOrigin(integration, req) {
  const target = new URL(
    req.path,
    integration.base_url.endsWith("/")
      ? integration.base_url
      : integration.base_url + "/",
  );
  if (
    target.origin !== new URL(integration.base_url).origin ||
    target.username ||
    target.password
  )
    throw new HttpError(
      400,
      "Test requests must stay on the configured system origin.",
    );
  if (req.path.startsWith("//") || req.path.includes("\\"))
    throw new HttpError(400, "Use a relative endpoint path.");
  return target;
}
async function record(integration, input, result) {
  const saved = integration.tools.find((t) => t.name === input.tool.name);
  if (
    saved &&
    identical(saved, input.tool) &&
    integration.base_url === input.base_url.replace(/\/$/, "") &&
    identical(integration.headers, input.headers)
  ) {
    await query(
      "UPDATE integrations SET last_test=$2 WHERE id=$1 AND config_revision=$3",
      [
        integration.id,
        {
          ok: result.ok,
          mode: input.mode,
          tool: saved.name,
          at: new Date().toISOString(),
          status: result.status,
        },
        integration.config_revision,
      ],
    );
  }
}
export async function testIntegration(workspaceId, id, input) {
  const integration = await loadIntegration(workspaceId, id);
  const scope = {
    args: resolveInputs(input.tool, input.args, input.context, input.steps),
    context: input.context,
    steps: input.steps,
    now: new Date(),
  };
  const draft = {
    ...integration,
    base_url: input.base_url.replace(/\/$/, ""),
    headers: input.headers,
  };
  const req = request(draft, input.tool.request, scope);
  withinOrigin(draft, req);
  if (
    input.tool.request.allow &&
    !new RegExp(input.tool.request.allow).test(req.path)
  )
    throw new HttpError(
      400,
      "The endpoint does not match this action’s allowed path.",
    );
  const preview = { mode: input.mode, request: req };
  if (input.mode === "preview") return preview;
  if (input.mode === "mock") {
    const ok = input.sample_status >= 200 && input.sample_status < 300;
    const result = {
      ...preview,
      ok,
      status: input.sample_status,
      result: ok ? readResponse(input.tool.response, input.mock, scope) : null,
      message: ok
        ? "Simulation complete. No request was sent."
        : `Simulated HTTP ${input.sample_status}.`,
      confirmation_required: input.tool.kind === "write",
    };
    await record(integration, input, result);
    return result;
  }
  readOnly(input.tool);
  if (draft.base_url !== integration.base_url)
    throw new HttpError(
      400,
      "Save the new system address before running a live test.",
    );
  if (integration.mode === "in_page") {
    if (input.mode !== "browser")
      throw new HttpError(
        400,
        "Run this test inside the connected system using the browser test script.",
      );
    const run = (
      await query(
        "INSERT INTO integration_test_runs (integration_id,definition,request,scope) VALUES ($1,$2,$3,$4) RETURNING id",
        [
          id,
          {
            input: { ...input, access_token: undefined },
            revision: integration.config_revision,
          },
          req,
          scope,
        ],
      )
    ).rows[0];
    const token = sign({ purpose: "integration_test", id: run.id }, 600);
    const api = (process.env.PUBLIC_API_URL || "http://localhost:3100").replace(
      /\/$/,
      "",
    );
    // Pasted by the administrator in their own signed-in tab; only the exact GET is performed.
    const script = `(async () => {\n  const origin = ${JSON.stringify(new URL(integration.base_url).origin)};\n  if (location.origin !== origin) throw new Error('Open this script inside ' + origin);\n  const request = ${JSON.stringify(req)};\n  const target = /^https?:/.test(request.path) ? request.path : ${JSON.stringify(integration.base_url)} + (request.path.startsWith('/') ? request.path : '/' + request.path);\n  if (new URL(target).origin !== origin || request.method !== 'GET') throw new Error('Unsafe test request');\n  const response = await fetch(target, {method:'GET', headers:request.headers, credentials:'include', redirect:'error', signal:AbortSignal.timeout(15000)});\n  const reader=response.body.getReader(); const chunks=[]; let size=0;\n  for (;;) { const part=await reader.read(); if(part.done) break; size+=part.value.byteLength; if(size>16000) { await reader.cancel(); throw new Error('Result too large. Request fewer records.'); } chunks.push(part.value); }\n  const text=await new Blob(chunks).text(); let body; try {body=JSON.parse(text)} catch {body=text}\n  const result=await fetch(${JSON.stringify(api + "/integration-tests/result")}, {method:'POST', headers:{'Content-Type':'application/json','X-Replybek-Test':${JSON.stringify(token)}}, body:JSON.stringify({status:response.status,body})});\n  console.log('Replybek test', await result.json());\n})();`;
    return {
      mode: "browser",
      run_id: run.id,
      script,
      message:
        "Run this script in your own signed-in system tab within 10 minutes. The result will appear here.",
    };
  }
  if (input.mode !== "live")
    throw new HttpError(400, "Use the server read test for this connection.");
  if (
    !["api_key", "none"].includes(integration.auth?.type) &&
    !input.access_token
  )
    throw new HttpError(
      400,
      "Supply a temporary test access token from your own account. It is not saved.",
    );
  const start = Date.now();
  let response;
  try {
    response = await send(draft, req, input.access_token);
  } catch (e) {
    throw new HttpError(
      502,
      e.name === "TimeoutError"
        ? "The system did not answer within 15 seconds."
        : "The system could not be reached. Check its address and availability.",
    );
  }
  const result = safeResult(
    {
      mode: "live",
      ok: response.ok,
      status: response.status,
      duration_ms: Date.now() - start,
      result: response.ok
        ? readResponse(input.tool.response, response.data, scope)
        : null,
      message: response.ok
        ? "Read test succeeded."
        : `HTTP ${response.status}. Check authentication, permissions and the endpoint.`,
    },
    [input.access_token, decrypt(integration.client_secret_enc)],
  );
  await record(integration, input, result);
  return result;
}
export async function finishBrowserTest(token, origin, response) {
  const signed = verify(token);
  if (signed?.purpose !== "integration_test")
    throw new HttpError(403, "The test link is invalid or expired.");
  const run = (
    await query(
      "SELECT r.*,i.base_url,i.workspace_id FROM integration_test_runs r JOIN integrations i ON i.id=r.integration_id WHERE r.id=$1 AND r.expires_at>now()",
      [signed.id],
    )
  ).rows[0];
  if (!run || new URL(run.base_url).origin !== origin)
    throw new HttpError(
      403,
      "Run this test from the configured system origin.",
    );
  const input = run.definition.input;
  const ok = response.status >= 200 && response.status < 300;
  const result = {
    mode: "browser",
    ok,
    status: response.status,
    result: ok
      ? readResponse(input.tool.response, response.body, run.scope)
      : null,
    message: ok
      ? "Browser read test succeeded."
      : `HTTP ${response.status}. Check your session and endpoint.`,
  };
  const saved = await query(
    "UPDATE integration_test_runs SET result=$2 WHERE id=$1 AND result IS NULL RETURNING id",
    [run.id, result],
  );
  if (!saved.rowCount)
    throw new HttpError(409, "This test was already completed.");
  const integration = await loadIntegration(
    run.workspace_id,
    run.integration_id,
  );
  if (integration.config_revision === run.definition.revision)
    await record(integration, input, result);
  return result;
}
export async function getBrowserTest(workspaceId, id, runId) {
  await loadIntegration(workspaceId, id);
  const run = (
    await query(
      "SELECT result, expires_at FROM integration_test_runs WHERE id=$1 AND integration_id=$2",
      [runId, id],
    )
  ).rows[0];
  if (!run) throw notFound("Test not found");
  return { result: run.result, expired: new Date(run.expires_at) < new Date() };
}
