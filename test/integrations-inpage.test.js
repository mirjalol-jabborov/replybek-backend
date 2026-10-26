import assert from "node:assert/strict";
import http from "node:http";
import { test, before, after } from "node:test";
import { owner, browser, drainJobs, query, base } from "./helpers/setup.js";

// A stand-in business system whose pages hold the session. "In-page" requests arrive with a session
// header (as a real browser would send its cookie); there is no OAuth and no stored token.
const sys = { created: [], seen: [] };
let sysUrl, server;

const readBody = (req) => new Promise((done) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => done(b)); });

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (code, data) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    const body = await readBody(req);
    if (req.headers["x-session"] !== "valid") return json(401, { message: "Требуется авторизация" });
    sys.seen.push({ path: url.pathname, filial: req.headers["filial_id"], body });
    if (url.pathname === "/b/me") return json(200, { user: { name: "Менеджер Алия", filial_id: "77" } });
    if (url.pathname === "/b/orders:table") return json(200, { count: 2, data: [["7", "Доставлен", "120000"], ["8", "Черновик", "45000"]] });
    if (url.pathname === "/b/orders:create") { sys.created.push(JSON.parse(body)); return json(200, { order_id: 55 }); }
    if (url.pathname === "/b/big:table") return json(200, { count: 5000, data: Array.from({ length: 5000 }, (_, i) => [String(i), "x".repeat(60)]) });
    return json(404, { message: "no route" });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  sysUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((done) => server.close(done)));

const integration = (agentId) => ({
  agent_id: agentId,
  name: "ERP",
  mode: "in_page",
  base_url: sysUrl,
  headers: { filial_id: "{{context.filial_id}}" },
  context: [{ name: "filial_id", request: { method: "POST", path: "/b/me" }, pick: "user.filial_id" }],
  account: { request: { method: "POST", path: "/b/me" }, pick: "user.name" },
  tools: [
    {
      name: "list_orders",
      description: "The customer's orders.",
      request: { path: "/b/orders:table", body: { p: { column: ["order_id", "status", "total"] } } },
      response: { type: "rows", columns: ["order_id", "status", "total"], filter: [{ field: "order_id", equals: "{{args.order_id}}" }] },
      input: { type: "object", properties: { order_id: { type: "string" } } },
    },
    {
      name: "place_order",
      kind: "write",
      description: "Places an order.",
      input: { type: "object", properties: { items: { type: "array" } }, required: ["items"] },
      request: { path: "/b/orders:create", body: { status: "D", items: { $each: "{{args.items}}", do: { product: "{{item.product}}", quantity: "{{item.quantity | number}}" } } } },
      response: { type: "json", pick: "order_id" },
      confirm: { title: "Новый заказ", lines: { $each: "{{args.items}}", do: ["{{item.product}}", "× {{item.quantity}}"] } },
    },
    {
      name: "read_any",
      description: "Read any screen. path + body.",
      input: { type: "object", properties: { path: { type: "string" }, body: { type: "object" } }, required: ["path"] },
      request: { method: "POST", path: "{{args.path}}", body: "{{args.body}}", allow: "^/b/[a-z/_]+:table$" },
      response: { type: "json" },
    },
  ],
});

async function setup() {
  process.env.PUBLIC_API_URL = base;
  const o = await owner();
  const w = `/w/${o.ws.id}`;
  const agent = (await o.b.call("POST", `${w}/agents`, { name: "ERP Help" })).body;
  await o.b.call("POST", `${w}/agents/${agent.id}/sources/qa`, { question: "Hours?", answer: "9 to 6." });
  await drainJobs();
  await o.b.call("POST", `${w}/agents/${agent.id}/publish`);
  const created = await o.b.call("POST", `${w}/integrations`, integration(agent.id));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const v = browser();
  const key = agent.public_key;
  const start = (await v.call("POST", `/widget/${key}/conversations`, {})).body;
  const IN = { "X-Visitor-Token": start.visitor_token, "X-Replybek-Inpage": sysUrl };
  return { o, w, agent, v, key, cid: start.conversation_id, IN, sysUrl };
}

// Plays the browser: send a message, then run any requests the AI hands back (against the system
// with a valid session), until an AI reply lands. Returns the last AI message.
async function aiCount(s, headers) {
  const r = (await s.v.call("GET", `/widget/${s.key}/conversations/${s.cid}/messages`, null, headers)).body;
  return (r.messages || []).filter((m) => m.role === "ai").length;
}
async function ask(s, text, headers = s.IN) {
  const base = await aiCount(s, headers);
  await s.v.call("POST", `/widget/${s.key}/conversations/${s.cid}/messages`, { text }, headers);
  return drive(s, headers, base);
}
async function confirm(s, actionId) {
  const base = await aiCount(s, s.IN);
  await s.v.call("POST", `/widget/${s.key}/conversations/${s.cid}/actions/${actionId}/confirm`, {}, s.IN);
  return drive(s, s.IN, base);
}
async function drive(s, headers, base) {
  for (let i = 0; i < 60; i++) {
    const r = (await s.v.call("GET", `/widget/${s.key}/conversations/${s.cid}/messages`, null, headers)).body;
    for (const tc of r.pending || []) {
      const req = tc.request;
      s.inspectRequest?.(req);
      const res = await fetch(s.sysUrl + req.path, {
        method: req.method || "POST",
        headers: { "x-session": "valid", "Content-Type": "application/json", ...(req.headers || {}) },
        body: req.body != null ? JSON.stringify(req.body) : undefined,
      });
      const body = await res.json().catch(() => null);
      await s.v.call("POST", `/widget/${s.key}/conversations/${s.cid}/tool-calls/${tc.id}`, { status: res.status, body }, headers);
    }
    const ai = (r.messages || []).filter((m) => m.role === "ai");
    if (ai.length > base && !(r.pending || []).length) return ai.at(-1);
    await new Promise((d) => setTimeout(d, 60));
  }
  throw new Error("no AI reply");
}

test("in-page: the AI reads the system in the customer's own session, no sign-in card", async () => {
  const s = await setup();
  const reply = await ask(s, "Покажи мои заказы [tool:list_orders {}]");
  assert.equal(reply.card, null, "no sign-in card for in-page");
  assert.match(reply.body, /"order_id":"7"/);
  // The context value read once (filial_id) is sent as a header on the tool call.
  assert.ok(sys.seen.some((x) => x.path === "/b/orders:table" && x.filial === "77"));
  // Account name was captured.
  assert.equal((await query("SELECT account_label FROM integration_connections")).rows[0].account_label, "Менеджер Алия");

  const one = await ask(s, '[tool:list_orders {"order_id":"8"}]');
  assert.match(one.body, /"order_id":"8"/);
  assert.doesNotMatch(one.body, /"order_id":"7"/);
});

test("in-page: a change waits for Confirm, then runs in the browser", async () => {
  const s = await setup();
  await ask(s, "orders [tool:list_orders {}]");
  const before = sys.created.length;
  const proposal = await ask(s, '[tool:place_order {"items":[{"product":"Чай","quantity":4}]}]');
  const card = proposal.card;
  assert.equal(card.type, "confirm");
  assert.deepEqual(card.lines, [["Чай", "× 4"]]);
  assert.equal(sys.created.length, before, "nothing sent before Confirm");

  const done = await confirm(s, card.action_id);
  assert.equal(done.body, "Done.");
  assert.deepEqual(sys.created.at(-1), { status: "D", items: [{ product: "Чай", quantity: 4 }] });
});

test("in-page: a generic tool reads any allowed endpoint, and refuses the rest", async () => {
  const s = await setup();
  const before = sys.seen.length;
  const ok = await ask(s, '[tool:read_any {"path":"/b/orders:table","body":{"p":{"column":["order_id","status","total"]}}}]');
  assert.match(ok.body, /"count":2/);
  assert.match(ok.body, /\["7","Доставлен"/);
  // A write-shaped path is refused before it ever reaches the browser.
  const refused = await ask(s, '[tool:read_any {"path":"/b/orders:create","body":{}}]');
  assert.match(refused.body, /not permitted|isn't permitted|not_allowed/i);
  const calls = sys.seen.slice(before).map((x) => x.path);
  assert.ok(calls.includes("/b/orders:table"));
  assert.ok(!calls.includes("/b/orders:create"), "the create endpoint was never reached");
});

test("in-page: an over-large result is capped, not dumped into the model", async () => {
  const s = await setup();
  const reply = await ask(s, '[tool:read_any {"path":"/b/big:table","body":{}}]');
  assert.match(reply.body, /too large|too_large/i);
});

test("in-page: when the chat is not inside the system, the tool can't run", async () => {
  const s = await setup();
  const before = sys.seen.length;
  // No X-Replybek-Inpage header: the chat isn't running inside the system.
  const plain = { "X-Visitor-Token": s.IN["X-Visitor-Token"] };
  const reply = await ask(s, "orders [tool:list_orders {}]", plain);
  assert.match(reply.body, /inside ERP|only works/i);
  assert.equal(sys.seen.length, before, "the system was never called");
});


test("in-page host-token configuration reaches every browser request without storing a credential", async () => {
  const s = await setup();
  await query("UPDATE integrations SET auth=$2 WHERE agent_id=$1", [s.agent.id, {browser_auth:"host_token",header:"Authorization",prefix:"Bearer "}]);
  let requests = 0;
  s.inspectRequest = req => {
    requests++;
    assert.deepEqual(req.browser_auth, {provider:"host_token",header:"Authorization",prefix:"Bearer "});
    assert.equal(req.headers.Authorization, undefined);
  };
  await ask(s, "Read orders [tool:list_orders {}]");
  assert.ok(requests >= 3, "context, account and action all require the host token provider");
  const stored = (await query("SELECT access_token_enc FROM integration_connections WHERE conversation_id=$1",[s.cid])).rows;
  assert.ok(stored.every(row => !row.access_token_enc));
});
