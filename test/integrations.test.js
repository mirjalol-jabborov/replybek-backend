import assert from "node:assert/strict";
import http from "node:http";
import { test, before, after } from "node:test";
import { owner, browser, drainJobs, query, base } from "./helpers/setup.js";

// A stand-in for a business system: OAuth sign-in, an orders table, an order endpoint.
const sys = { codes: new Map(), tokens: new Map(), refreshes: 0, created: [], seen: [] };
let sysUrl;
let server;

function readBody(req) {
  return new Promise((done) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => done(b));
  });
}

before(async () => {
  server = http.createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (e) {
      res.writeHead(500).end(String(e.message));
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  sysUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((done) => server.close(done)));

async function handle(req, res) {
  {
    const url = new URL(req.url, "http://x");
    const json = (status, data) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    const body = await readBody(req);
    // The customer signs in here and is sent back with a code.
    if (url.pathname === "/oauth/authorize") {
      const code = `code-${sys.codes.size + 1}`;
      sys.codes.set(code, { user: "buyer-7" });
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state"));
      return res.writeHead(302, { Location: back.toString() }).end();
    }
    if (url.pathname === "/oauth/token") {
      const f = JSON.parse(body);
      if (f.client_secret !== "s3cret") return json(401, { error: "invalid_client" });
      if (f.grant_type === "refresh_token") sys.refreshes += 1;
      else if (!sys.codes.delete(f.code)) return json(400, { error: "invalid_grant" });
      const token = `tok-${sys.tokens.size + 1}`;
      sys.tokens.set(token, "buyer-7");
      // Short-lived on purpose: the next tool call has to refresh it.
      return json(200, { access_token: token, refresh_token: "ref-1", expires_in: 1 });
    }
    const auth = (req.headers.authorization || "").replace("Bearer ", "");
    if (!sys.tokens.has(auth)) return json(401, { message: "Unauthorized" });
    if ("x-branch" in req.headers) return json(401, { message: "x-branch must not be sent empty" });
    sys.seen.push({ path: url.pathname, account: req.headers["x-account"], body });
    if (url.pathname === "/api/me") return json(200, { user: { name: "Demo Buyer", account_id: "A-7" } });
    if (url.pathname === "/api/orders:table")
      return json(200, { count: 2, data: [["7", "Delivered", "120000"], ["8", "Draft", "45000"]] });
    if (url.pathname === "/api/orders:create") {
      sys.created.push(JSON.parse(body));
      return json(200, { order_id: 42 });
    }
    return json(404, { message: "no route" });
  }
}

const integration = (agentId) => ({
  agent_id: agentId,
  name: "Shop ERP",
  base_url: sysUrl,
  auth: { authorize_url: "/oauth/authorize", token_url: "/oauth/token", client_id: "replybek", scope: "read+write", token_format: "json" },
  client_secret: "s3cret",
  headers: { "x-account": "{{context.account_id}}", "x-branch": "{{context.branch_id}}" },
  context: [{ name: "account_id", request: { method: "GET", path: "/api/me" }, pick: "user.account_id" }],
  account: { request: { method: "GET", path: "/api/me" }, pick: "user.name" },
  tools: [
    {
      name: "list_orders",
      description: "The customer's orders with status and total.",
      when: "The customer asks about their orders or an order status.",
      request: { path: "/api/orders:table", body: { p: { column: ["order_id", "status", "total"], limit: 20 } } },
      response: { type: "rows", columns: ["order_id", "status", "total"], filter: [{ field: "order_id", equals: "{{args.order_id}}" }] },
      input: { type: "object", properties: { order_id: { type: "string" } } },
    },
    {
      name: "place_order",
      kind: "write",
      description: "Places an order for the customer.",
      input: { type: "object", properties: { items: { type: "array" }, delivery: { type: "string" } }, required: ["items"] },
      request: {
        path: "/api/orders:create",
        body: { status: "D", delivery: "{{args.delivery | date:DD.MM.YYYY}} 00:00", items: { $each: "{{args.items}}", do: { product: "{{item.product}}", quantity: "{{item.quantity | number}}" } } },
      },
      response: { type: "json", pick: "order_id" },
      confirm: { title: "New order", lines: { $each: "{{args.items}}", do: ["{{item.product}}", "× {{item.quantity}}"] } },
    },
  ],
});

async function setup() {
  process.env.PUBLIC_API_URL = base; // the test app's address is known once it listens
  const o = await owner();
  const w = `/w/${o.ws.id}`;
  const agent = (await o.b.call("POST", `${w}/agents`, { name: "Shop Help" })).body;
  await o.b.call("POST", `${w}/agents/${agent.id}/sources/qa`, { question: "Do you deliver?", answer: "Yes, every weekday." });
  await drainJobs();
  await o.b.call("POST", `${w}/agents/${agent.id}/publish`);
  const created = await o.b.call("POST", `${w}/integrations`, integration(agent.id));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const v = browser();
  const key = agent.public_key;
  const start = (await v.call("POST", `/widget/${key}/conversations`, {})).body;
  const vt = { "X-Visitor-Token": start.visitor_token };
  const say = (text) => v.call("POST", `/widget/${key}/conversations/${start.conversation_id}/messages`, { text }, vt);
  return { o, w, agent, v, key, cid: start.conversation_id, vt, say, integrationId: created.body.id };
}

async function signIn(s) {
  const r = await s.v.call("POST", `/widget/${s.key}/conversations/${s.cid}/integrations/${s.integrationId}/connect`, {}, s.vt);
  assert.equal(r.status, 200);
  const auth = await fetch(r.body.url, { redirect: "manual" });
  const page = await fetch(auth.headers.get("location"));
  return page;
}

async function waitFor(s, check) {
  for (let i = 0; i < 40; i++) {
    const r = await s.v.call("GET", `/widget/${s.key}/conversations/${s.cid}/messages`, null, s.vt);
    const hit = r.body.messages.find(check);
    if (hit) return hit;
    await new Promise((d) => setTimeout(d, 100));
  }
  throw new Error("timed out waiting for a message");
}

test("a signed-out customer gets a sign-in card; after signing in the waiting question is answered from the system", async () => {
  const s = await setup();
  const first = await s.say("What are my orders? [tool:list_orders {}]");
  const reply = first.body.messages.at(-1);
  assert.equal(reply.card.type, "connect");
  assert.equal(reply.card.name, "Shop ERP");
  assert.match(reply.body, /signed in/);

  const page = await signIn(s);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Signed in as Demo Buyer/);

  const answer = await waitFor(s, (m) => m.role === "ai" && m.body.startsWith("list_orders →"));
  assert.match(answer.body, /"order_id":"7"/);
  assert.match(answer.body, /"total":2/);
  // Context read at sign-in is sent with every call.
  assert.ok(sys.seen.some((x) => x.path === "/api/orders:table" && x.account === "A-7"));
  // The short-lived token was refreshed, not shown to anyone.
  assert.ok(sys.refreshes >= 1);

  // Filters use the model's arguments.
  const one = await s.say('[tool:list_orders {"order_id":"8"}]');
  assert.match(one.body.messages.at(-1).body, /"order_id":"8"/);
  assert.doesNotMatch(one.body.messages.at(-1).body, /"order_id":"7"/);

  // Tokens and the client secret are stored encrypted, and never returned.
  const conn = (await query("SELECT access_token_enc, account_label FROM integration_connections")).rows[0];
  assert.equal(conn.account_label, "Demo Buyer");
  assert.doesNotMatch(conn.access_token_enc, /tok-/);
  const list = await s.o.b.call("GET", `${s.w}/integrations`);
  assert.equal(list.body[0].has_client_secret, true);
  assert.equal(JSON.stringify(list.body).includes("s3cret"), false);

  // The "When to use" field is stored and returned.
  assert.match(list.body[0].tools.find((t) => t.name === "list_orders").when, /order status/);

  // Dry-run preview renders the exact request without calling the system.
  const seenBefore = sys.seen.length;
  const prev = await s.o.b.call("POST", `${s.w}/integrations/${s.integrationId}/tools/list_orders/preview`, { args: { order_id: "9" } });
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  assert.equal(prev.body.request.method, "POST");
  assert.equal(prev.body.request.path, "/api/orders:table");
  assert.equal(sys.seen.length, seenBefore, "preview does not hit the system");
  const missing = await s.o.b.call("POST", `${s.w}/integrations/${s.integrationId}/tools/nope/preview`, {});
  assert.equal(missing.status, 404);
});

test("changes wait for the customer's confirmation; cancelling changes nothing", async () => {
  const s = await setup();
  await s.say("My orders? [tool:list_orders {}]");
  await signIn(s);
  await waitFor(s, (m) => m.role === "ai" && m.body.startsWith("list_orders →"));
  const before = sys.created.length;

  const proposal = await s.say('[tool:place_order {"items":[{"product":"Tea","quantity":3},{"product":"Cola","quantity":10}],"delivery":"2026-11-02"}]');
  const card = proposal.body.messages.at(-1).card;
  assert.equal(card.type, "confirm");
  assert.equal(card.status, "pending");
  assert.deepEqual(card.lines, [["Tea", "× 3"], ["Cola", "× 10"]]);
  assert.equal(sys.created.length, before, "nothing is sent before Confirm");

  const done = await s.v.call("POST", `/widget/${s.key}/conversations/${s.cid}/actions/${card.action_id}/confirm`, {}, s.vt);
  assert.equal(done.status, 200);
  assert.equal(done.body.messages.at(-1).body, "Done.");
  assert.deepEqual(sys.created.at(-1), { status: "D", delivery: "02.11.2026 00:00", items: [{ product: "Tea", quantity: 3 }, { product: "Cola", quantity: 10 }] });
  const again = await s.v.call("POST", `/widget/${s.key}/conversations/${s.cid}/actions/${card.action_id}/confirm`, {}, s.vt);
  assert.equal(again.status, 409, "a confirmation can't run twice");
  const msgs = await s.v.call("GET", `/widget/${s.key}/conversations/${s.cid}/messages`, null, s.vt);
  assert.equal(msgs.body.messages.find((m) => m.card?.action_id === card.action_id).card.status, "done");

  const second = await s.say('[tool:place_order {"items":[{"product":"Tea","quantity":1}]}]');
  const card2 = second.body.messages.at(-1).card;
  const cancelled = await s.v.call("POST", `/widget/${s.key}/conversations/${s.cid}/actions/${card2.action_id}/cancel`, {}, s.vt);
  assert.equal(cancelled.body.messages.at(-1).body, "Cancelled.");
  assert.equal(sys.created.length, before + 1);
});

test("sign-in links and actions belong to their conversation", async () => {
  const s = await setup();
  const other = browser();
  const r = await other.call("POST", `/widget/${s.key}/conversations/${s.cid}/integrations/${s.integrationId}/connect`, {}, { "X-Visitor-Token": "wrong" });
  assert.equal(r.status, 404);
  const forged = await fetch(`${base}/oauth/callback?code=x&state=forged.state`);
  assert.equal(forged.status, 400);
  assert.match(await forged.text(), /expired/);
  // Admins only, and tool names are checked.
  const bad = await s.o.b.call("POST", `${s.w}/integrations`, { ...integration(s.agent.id), tools: [{ ...integration(s.agent.id).tools[0], name: "Bad Name" }] });
  assert.equal(bad.status, 400);
});
