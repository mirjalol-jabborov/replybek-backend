import assert from "node:assert/strict";
import http from "node:http";
import { test, before, after } from "node:test";
import { owner, query, base } from "./helpers/setup.js";
import {
  importDefinition,
  exportPackage,
  resolveInputs,
  modelInput,
} from "../src/lib/integration-config.js";
import {
  runTool,
  decideAction,
  loadIntegration,
  simulateProcedure,
} from "../src/services/integrations.service.js";
import { startConversation } from "../src/services/widget.service.js";

let system,
  url,
  calls = [];
before(async () => {
  system = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    calls.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      body: text ? JSON.parse(text) : null,
    });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/me")
      return res.end(JSON.stringify({ id: "trusted-account" }));
    if (req.url === "/inventory")
      return res.end(
        JSON.stringify({
          data: { id: "product-7", available: 5, private_field: "hidden" },
        }),
      );
    if (req.url === "/create")
      return res.end(JSON.stringify({ id: "order-" + calls.length }));
    if (req.url === "/echo")
      return res.end(JSON.stringify({ auth: req.headers.authorization }));
    res.writeHead(404).end("{}");
  });
  await new Promise((done) => system.listen(0, "127.0.0.1", done));
  url = `http://127.0.0.1:${system.address().port}`;
});
after(() => new Promise((done) => system.close(done)));
const read = {
  name: "find_inventory",
  description: "Find stock",
  kind: "read",
  input: { type: "object", properties: {} },
  request: { method: "GET", path: "/inventory" },
  response: {
    type: "json",
    pick: "data",
    fields: { id: "id", available: "available" },
  },
};
const write = {
  name: "create_order",
  description: "Create order",
  kind: "write",
  input: {
    type: "object",
    properties: {
      product: { type: "string" },
      account: { type: "string" },
      quantity: { type: "number" },
    },
    required: ["product", "account", "quantity"],
  },
  bindings: {
    account: { source: "context", path: "account_id" },
    product: { source: "step", path: "lookup.id" },
  },
  request: {
    method: "POST",
    path: "/create",
    body: {
      product: "{{args.product}}",
      account: "{{args.account}}",
      quantity: "{{args.quantity}}",
    },
  },
  response: { type: "json" },
  confirm: {
    title: "Create order",
    lines: [["Quantity", "{{args.quantity}}"]],
  },
};
const procedure = {
  name: "order_workflow",
  description: "Check stock then order",
  input: {
    type: "object",
    properties: { quantity: { type: "number", minimum: 1 } },
    required: ["quantity"],
  },
  steps: [
    { id: "lookup", kind: "action", tool: "find_inventory", args: {} },
    {
      id: "stock",
      kind: "check",
      condition: {
        path: "steps.lookup.available",
        op: "greater_than",
        value: 0,
      },
      message: "Out of stock",
    },
    {
      id: "create",
      kind: "action",
      tool: "create_order",
      args: { quantity: "{{args.quantity}}" },
    },
  ],
};
async function setup(patch = {}) {
  const o = await owner();
  const w = `/w/${o.ws.id}`;
  const agent = (
    await o.b.call("POST", `${w}/agents`, { name: "Generic support" })
  ).body;
  const created = await o.b.call("POST", `${w}/integrations`, {
    agent_id: agent.id,
    name: "Business API",
    mode: "server",
    base_url: url,
    auth: { type: "none" },
    context: [
      {
        name: "account_id",
        request: { method: "GET", path: "/me" },
        pick: "id",
      },
    ],
    tools: [read, write],
    procedures: [procedure],
    ...patch,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const integration = await loadIntegration(o.ws.id, created.body.id);
  const conv = await startConversation(agent, {});
  return { ...o, w, agent, integration, conv };
}

test("cURL import parses quoted JSON and never executes shell syntax; removes credentials", () => {
  const r = importDefinition(
    "curl",
    `curl 'https://example.com/orders?access_token=private&limit=3' -H 'Authorization: Bearer private' -H 'X-Custom-Key: abc' --data-raw '{"name":"two words","password":"private"}'`,
  );
  assert.equal(r.integration.tools[0].kind, "write");
  assert.equal(r.integration.tools[0].request.body.name, "{{args.name}}");
  assert.ok(!JSON.stringify(r).includes("private"));
  assert.equal(r.integration.tools[0].request.headers.Authorization, "");
  assert.throws(() =>
    importDefinition("curl", "curl https://example.com; touch /tmp/oops"),
  );
  assert.throws(() =>
    importDefinition("curl", "curl https://example.com -d @secret.json"),
  );
});
test("OpenAPI JSON/YAML imports refs and query encoding, rejects ambiguous unsupported input", () => {
  const r = importDefinition(
    "openapi",
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Catalog" },
      servers: [{ url: "https://example.com/api" }],
      components: {
        parameters: {
          ID: {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        },
      },
      paths: {
        "/orders/{id}": {
          get: {
            operationId: "getOrder",
            parameters: [{ $ref: "#/components/parameters/ID" }],
          },
        },
      },
    }),
  );
  assert.equal(
    r.integration.tools[0].request.path,
    "/orders/{{args.id | url}}",
  );
  assert.equal(r.integration.tools[0].kind, "read");
  assert.deepEqual(r.integration.tools[0].input.required, ["id"]);
  assert.throws(() => importDefinition("openapi", "openapi: 2.0\npaths: {}"));
});
test("configuration packages remove secrets, sessions and fixed bindings and start disabled", () => {
  const p = exportPackage({
    name: "ERP",
    mode: "server",
    base_url: "https://u:secret@example.com?api_key=secret",
    auth: { type: "api_key", client_id: "secret" },
    client_secret: "secret",
    client_secret_enc: "cipher",
    headers: { Authorization: "Bearer secret", Other: "secret" },
    tools: [
      {
        ...read,
        bindings: { account: { source: "fixed", value: "secret" } },
        request: {
          method: "GET",
          path: "/x?token=secret",
          headers: { Authorization: "secret" },
        },
      },
    ],
    connections: [{ token: "secret" }],
  });
  assert.ok(!JSON.stringify(p).includes("secret"));
  assert.ok(!JSON.stringify(p).includes("cipher"));
  assert.equal(p.integration.enabled, false);
  assert.deepEqual(p.integration.tools[0].bindings.account, {
    source: "fixed", value: null,
  });
});
test("protected bindings override AI input, preserve types, and are omitted from model parameters", () => {
  const t = {
    input: {
      type: "object",
      properties: {
        account: { type: "string" },
        count: { type: "number" },
        choice: { type: "string" },
      },
      required: ["account", "count", "choice"],
    },
    bindings: {
      account: { source: "context", path: "account.id" },
      count: { source: "fixed", value: 4 },
    },
  };
  assert.deepEqual(
    resolveInputs(
      t,
      { account: "attacker", count: 99, choice: "yes" },
      { account: { id: "own" } },
    ),
    { account: "own", count: 4, choice: "yes" },
  );
  assert.deepEqual(Object.keys(modelInput(t).properties), ["choice"]);
  assert.throws(() => resolveInputs(t, { choice: "yes" }));
});
test("admin import/export and tests enforce tenant boundaries and reject invalid merged auth", async () => {
  const x = await setup();
  const other = await owner();
  assert.equal(
    (
      await other.b.call(
        "GET",
        `/w/${other.ws.id}/integrations/${x.integration.id}/export`,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await x.b.call("PATCH", `${x.w}/integrations/${x.integration.id}`, {
        auth: { type: "oauth" },
      })
    ).status,
    400,
  );
  const exported = await x.b.call(
    "GET",
    `${x.w}/integrations/${x.integration.id}/export`,
  );
  assert.equal(exported.status, 200);
  assert.equal(exported.body.version, 1);
  const imported = await x.b.call("POST", `${x.w}/integrations/import`, {
    format: "package",
    source: JSON.stringify(exported.body),
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.integration.procedures.length, 1);
});
test("read tests perform one GET, shape fields, record status; write simulation makes no request", async () => {
  const x = await setup();
  let before = calls.length;
  const r = await x.b.call(
    "POST",
    `${x.w}/integrations/${x.integration.id}/test`,
    { tool: x.integration.tools[0], base_url: url, mode: "live" },
  );
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(calls.length, before + 1);
  assert.equal(r.body.result.private_field, undefined);
  assert.equal(r.body.result.id, "product-7");
  assert.equal(
    (await loadIntegration(x.ws.id, x.integration.id)).last_test.ok,
    true,
  );
  const body = {
    tool: x.integration.tools[1],
    base_url: url,
    mode: "mock",
    args: { quantity: 2 },
    context: { account_id: "sample" },
    steps: { lookup: { id: "sample" } },
    mock: { id: "simulated" },
  };
  before = calls.length;
  const mock = await x.b.call(
    "POST",
    `${x.w}/integrations/${x.integration.id}/test`,
    body,
  );
  assert.equal(mock.status, 200, JSON.stringify(mock.body));
  assert.equal(mock.body.confirmation_required, true);
  assert.equal(calls.length, before);
  const live = await x.b.call(
    "POST",
    `${x.w}/integrations/${x.integration.id}/test`,
    { ...body, mode: "live" },
  );
  assert.equal(live.status, 400);
  assert.equal(calls.length, before);
  const wrong = await x.b.call(
    "POST",
    `${x.w}/integrations/${x.integration.id}/test`,
    {
      tool: x.integration.tools[0],
      base_url: "https://example.com",
      mode: "live",
    },
  );
  assert.equal(wrong.status, 400);
});
test("API key test credentials are encrypted and redacted even if the system echoes them", async () => {
  const x = await setup({
    auth: { type: "api_key" },
    client_secret: "test-private-key",
    tools: [
      {
        ...read,
        request: { method: "GET", path: "/echo" },
        response: { type: "json" },
      },
    ],
    procedures: [],
  });
  assert.notEqual(x.integration.client_secret_enc, "test-private-key");
  const r = await x.b.call(
    "POST",
    `${x.w}/integrations/${x.integration.id}/test`,
    { tool: x.integration.tools[0], base_url: url, mode: "live" },
  );
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.body).includes("test-private-key"));
  assert.equal(calls.at(-1).auth, "Bearer test-private-key");
});
test("procedure executes reads, pauses before write, uses trusted context and resumes after exactly one confirmation", async () => {
  const x = await setup();
  const started = await runTool({
    conversationId: x.conv.conversation_id,
    integration: x.integration,
    tool: { ...procedure, procedure: true },
    args: { quantity: 2 },
  });
  assert.equal(started.card.type, "confirm");
  const before = calls.filter((c) => c.url === "/create").length;
  const results = await Promise.allSettled([
    decideAction(x.conv.conversation_id, started.card.action_id, true),
    decideAction(x.conv.conversation_id, started.card.action_id, true),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const out = results.find((r) => r.status === "fulfilled").value;
  assert.equal(out.status, "done");
  assert.equal(out.continuation.output.status, "completed");
  assert.equal(calls.filter((c) => c.url === "/create").length, before + 1);
  assert.deepEqual(calls.at(-1).body, {
    product: "product-7",
    account: "trusted-account",
    quantity: 2,
  });
});
test("procedure cancellation stops future steps; simulation runs conditions without network calls", async () => {
  const x = await setup();
  const started = await runTool({
    conversationId: x.conv.conversation_id,
    integration: x.integration,
    tool: { ...procedure, procedure: true },
    args: { quantity: 2 },
  });
  const before = calls.length;
  const out = await decideAction(
    x.conv.conversation_id,
    started.card.action_id,
    false,
  );
  assert.equal(out.continuation.output.status, "cancelled");
  assert.equal(calls.length, before);
  const r = simulateProcedure({
    procedure,
    tools: x.integration.tools,
    args: { quantity: 2 },
    context: { account_id: "a" },
    mocks: { lookup: { data: { id: "p", available: 0 } } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.message, "Out of stock");
  assert.equal(calls.length, before);
  const pass = simulateProcedure({
    procedure,
    tools: x.integration.tools,
    args: { quantity: 2 },
    context: { account_id: "a" },
    mocks: { lookup: { data: { id: "p", available: 2 } }, create: { id: "o" } },
  });
  assert.equal(pass.ok, true);
  assert.equal(pass.trace.at(-1).confirmation_required, true);
  assert.equal(calls.length, before);
});
test("changed action invalidates a pending confirmation instead of performing a different write", async () => {
  const x = await setup();
  const start = await runTool({
    conversationId: x.conv.conversation_id,
    integration: x.integration,
    tool: { ...procedure, procedure: true },
    args: { quantity: 1 },
  });
  await x.b.call("PATCH", `${x.w}/integrations/${x.integration.id}`, {
    tools: x.integration.tools.map((t) =>
      t.kind === "write"
        ? { ...t, request: { ...t.request, path: "/different" } }
        : t,
    ),
  });
  const before = calls.length;
  assert.equal(
    (await decideAction(x.conv.conversation_id, start.card.action_id, true))
      .status,
    "failed",
  );
  assert.equal(calls.length, before);
});
test("browser read tests are origin-bound, short-lived, one-use and isolated from customer conversations", async () => {
  const x = await setup({ mode: "in_page" });
  process.env.PUBLIC_API_URL = base;
  const r = await x.b.call(
    "POST",
    `${x.w}/integrations/${x.integration.id}/test`,
    { tool: x.integration.tools[0], base_url: url, mode: "browser" },
  );
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const token = r.body.script.match(/'X-Replybek-Test':"([^"]+)"/)[1];
  const send = (origin) =>
    fetch(base + "/integration-tests/result", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Replybek-Test": token,
        Origin: origin,
      },
      body: JSON.stringify({
        status: 200,
        body: { data: { id: "browser-product", available: 4 } },
      }),
    });
  assert.equal((await send("https://wrong.example")).status, 403);
  assert.equal((await send(url)).status, 200);
  assert.equal((await send(url)).status, 409);
  const result = await x.b.call(
    "GET",
    `${x.w}/integrations/${x.integration.id}/tests/${r.body.run_id}`,
  );
  assert.equal(result.body.result.result.id, "browser-product");
});

test("a tested draft stays tested when enabled without changing its configuration", async () => {
  const x = await setup({ enabled: false });
  await x.b.call("POST", `${x.w}/integrations/${x.integration.id}/test`, {
    tool: x.integration.tools[0],
    base_url: url,
    mode: "live",
  });
  const r = await x.b.call("PATCH", `${x.w}/integrations/${x.integration.id}`, {
    name: x.integration.name,
    mode: x.integration.mode,
    base_url: url,
    auth: x.integration.auth,
    headers: x.integration.headers,
    context: x.integration.context,
    account: x.integration.account,
    tools: x.integration.tools,
    procedures: x.integration.procedures,
    enabled: true,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.last_test.ok, true);
  assert.equal(
    (await loadIntegration(x.ws.id, x.integration.id)).config_revision,
    x.integration.config_revision,
  );
});
test("connection edits invalidate pending writes and clear cached account context", async () => {
  const x = await setup();
  const started = await runTool({
    conversationId: x.conv.conversation_id,
    integration: x.integration,
    tool: { ...procedure, procedure: true },
    args: { quantity: 1 },
  });
  const edit = await x.b.call(
    "PATCH",
    `${x.w}/integrations/${x.integration.id}`,
    { headers: { "X-Account": "different" } },
  );
  assert.equal(edit.status, 200);
  const before = calls.length;
  assert.equal(
    (await decideAction(x.conv.conversation_id, started.card.action_id, true))
      .status,
    "failed",
  );
  assert.equal(calls.length, before);
  assert.equal(
    (
      await query(
        "SELECT id FROM integration_connections WHERE integration_id=$1",
        [x.integration.id],
      )
    ).rowCount,
    0,
  );
});
test("each procedure write has its own confirmation and cancelling the second stops it", async () => {
  const p = {
    ...procedure,
    steps: [
      ...procedure.steps,
      {
        id: "second",
        kind: "action",
        tool: "create_order",
        args: { quantity: 1 },
      },
    ],
  };
  const x = await setup({ procedures: [p] });
  const started = await runTool({
    conversationId: x.conv.conversation_id,
    integration: x.integration,
    tool: { ...p, procedure: true },
    args: { quantity: 2 },
  });
  const before = calls.filter((c) => c.url === "/create").length;
  const first = await decideAction(
    x.conv.conversation_id,
    started.card.action_id,
    true,
  );
  assert.equal(first.status, "done");
  assert.equal(first.continuation.card.type, "confirm");
  assert.notEqual(first.continuation.card.action_id, started.card.action_id);
  const second = await decideAction(
    x.conv.conversation_id,
    first.continuation.card.action_id,
    false,
  );
  assert.equal(second.continuation.output.status, "cancelled");
  assert.equal(calls.filter((c) => c.url === "/create").length, before + 1);
});
test("procedure checks can use trusted account context before the first action", async () => {
  const p = {
    ...procedure,
    steps: [
      {
        id: "account_check",
        kind: "check",
        condition: {
          path: "context.account_id",
          op: "equals",
          value: "trusted-account",
        },
      },
      ...procedure.steps,
    ],
  };
  const x = await setup({ procedures: [p] });
  const started = await runTool({
    conversationId: x.conv.conversation_id,
    integration: x.integration,
    tool: { ...p, procedure: true },
    args: { quantity: 2 },
  });
  assert.equal(started.card.type, "confirm");
  await decideAction(x.conv.conversation_id, started.card.action_id, false);
});
test("malformed package and input schemas fail as validation errors", async () => {
  const x = await setup();
  assert.equal(
    (
      await x.b.call("POST", `${x.w}/integrations/import`, {
        format: "package",
        source: JSON.stringify({
          format: "replybek.integration",
          version: 1,
          integration: { name: "Bad", tools: {} },
        }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await x.b.call("POST", `${x.w}/integrations/${x.integration.id}/test`, {
        tool: {
          ...read,
          input: { type: "object", properties: { x: { type: "imaginary" } } },
        },
        base_url: url,
        mode: "mock",
        mock: {},
      })
    ).status,
    400,
  );
});
