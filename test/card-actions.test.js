import assert from "node:assert/strict";
import http from "node:http";
import { test, before, after } from "node:test";
import { owner, browser, query, drainJobs } from "./helpers/setup.js";
import { fakeAI } from "../src/ai.js";

// A flower shop: a catalog, and a basket that takes one bouquet at a time.
const shop = { added: [] };
let shopUrl;
let server;
before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (status, data) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
      if (req.url.startsWith("/flowers")) return json(200, { products: [
        { id: 11, title: "Peony cloud", price: 850000, image: "https://shop.example/peony.jpg", url: "https://shop.example/p/peony" },
        { id: 12, title: "White roses", price: 640000, image: "https://shop.example/roses.jpg", url: "https://shop.example/p/roses" },
      ] });
      if (req.url === "/cart" && req.method === "POST") {
        const b = JSON.parse(body);
        if (b.product_id === 13) return json(409, { message: "Sold out" });
        shop.added.push(b);
        return json(200, { ok: true, count: shop.added.length });
      }
      json(404, { message: "no route" });
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  shopUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((done) => server.close(done)));

async function setup(action = { tool: "add_to_basket", label: { en: "Add to basket", uz: "Savatga" }, done: { en: "In the basket" }, args: { product_id: "id", title: "title", qty: 1 } }) {
  const o = await owner();
  const w = `/w/${o.ws.id}`;
  const agent = (await o.b.call("POST", `${w}/agents`, { name: "Florist" })).body;
  await o.b.call("POST", `${w}/agents/${agent.id}/publish`);
  const made = await o.b.call("POST", `${w}/integrations`, {
    agent_id: agent.id, name: "Shop", mode: "server", base_url: shopUrl, auth: { type: "none" },
    tools: [
      { name: "find_flowers", kind: "read", description: "Finds bouquets.", input: { type: "object", properties: {} }, request: { method: "GET", path: "/flowers" },
        display: { items: "products", title: "title", image: "image", price: "price", currency: "сум", url: "url", id: "id", action } },
      { name: "add_to_basket", kind: "write", description: "Adds a bouquet to the basket.",
        input: { type: "object", properties: { product_id: { type: "integer" }, title: { type: "string" }, qty: { type: "integer" } }, required: ["product_id", "qty"] },
        request: { method: "POST", path: "/cart", body: { product_id: "{{args.product_id | number}}", qty: "{{args.qty | number}}" } },
        confirm: { title: "Add to basket", lines: [["{{args.title}}", "{{args.qty}}"]] } },
    ],
  });
  const v = browser();
  const start = (await v.call("POST", `/widget/${agent.public_key}/conversations`, {})).body;
  const key = agent.public_key, cid = start.conversation_id, vt = { "X-Visitor-Token": start.visitor_token };
  const say = (text) => v.call("POST", `/widget/${key}/conversations/${cid}/messages`, { text }, vt);
  const tap = (mid, n) => v.call("POST", `/widget/${key}/conversations/${cid}/messages/${mid}/cards/${n}/action`, {}, vt);
  return { o, w, agent, made, v, key, cid, vt, say, tap };
}

test("a card's button runs its action for that item in one tap, once, and the next answer knows the cards", async () => {
  const s = await setup();
  assert.equal(s.made.status, 201, JSON.stringify(s.made.body));
  const shown = (await s.say("Bouquets? [tool:find_flowers {}]")).body.messages.at(-1);
  assert.equal(shown.card.type, "products");
  assert.deepEqual(shown.card.items.map((i) => [i.id, i.args]), [["11", { product_id: 11, title: "Peony cloud", qty: 1 }], ["12", { product_id: 12, title: "White roses", qty: 1 }]]);
  assert.deepEqual(shown.card.action.label, { en: "Add to basket", uz: "Savatga" });

  // The next question sees what was on the cards, in order, with ids.
  await s.say("Tell me about the first one");
  assert.match(fakeAI.lastAnswer.user, /\[Cards shown under this reply, in this order: 1\) Peony cloud, 850000 сум \(id 11\); 2\) White roses, 640000 сум \(id 12\)\]/);

  const before = shop.added.length;
  const r = await s.tap(shown.id, 1);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(shop.added.slice(before), [{ product_id: 12, qty: 1 }], "the tapped item, without a separate Confirm");
  const again = await s.tap(shown.id, 1);
  assert.equal(again.status, 409, "a tap can't run twice");
  assert.equal(shop.added.length, before + 1);
  const msgs = (await s.v.call("GET", `/widget/${s.key}/conversations/${s.cid}/messages`, null, s.vt)).body.messages;
  assert.equal(msgs.find((m) => m.id === shown.id).card.taps["1"].status, "done", "the button stays done after a reload");
  assert.equal(msgs.at(-1).role, "ai", "the agent says what happened");

  assert.equal((await s.tap(shown.id, 5)).status, 404, "no such card");
  assert.equal((await s.tap("00000000-0000-0000-0000-000000000000", 0)).status, 404);
});

test("a card button must run a write action", async () => {
  const s = await setup({ tool: "find_flowers", label: "Again", args: {} });
  assert.equal(s.made.status, 400);
  assert.match(JSON.stringify(s.made.body), /card button on find_flowers must run a write action/);
});

test("a card can let the customer choose how many: the tap sends the number, kept between 1 and 99", async () => {
  const s = await setup({ tool: "add_to_basket", label: "Add", args: { product_id: "id", title: "title" }, quantity: "qty" });
  assert.equal(s.made.status, 201, JSON.stringify(s.made.body));
  const shown = (await s.say("[tool:find_flowers {}]")).body.messages.at(-1);
  assert.equal(shown.card.action.quantity, "qty");
  const before = shop.added.length;
  assert.equal((await s.v.call("POST", `/widget/${s.key}/conversations/${s.cid}/messages/${shown.id}/cards/0/action`, { qty: 3 }, s.vt)).status, 200);
  assert.equal((await s.v.call("POST", `/widget/${s.key}/conversations/${s.cid}/messages/${shown.id}/cards/1/action`, { qty: 5000 }, s.vt)).status, 200);
  assert.deepEqual(shop.added.slice(before), [{ product_id: 11, qty: 3 }, { product_id: 12, qty: 99 }]);
  const card = (await s.v.call("GET", `/widget/${s.key}/conversations/${s.cid}/messages`, null, s.vt)).body.messages.find((m) => m.id === shown.id).card;
  assert.equal(card.taps["0"].qty, 3);
});

test("on the website an answer waits while the visitor types, and gives way to the message they send", async () => {
  const o = await owner();
  const w = `/w/${o.ws.id}`;
  const agent = (await o.b.call("POST", `${w}/agents`, { name: "Florist" })).body;
  await o.b.call("POST", `${w}/agents/${agent.id}/sources/qa`, { question: "What is your return policy?", answer: "Unworn items with tags can be returned within 30 days of delivery." });
  await drainJobs();
  await o.b.call("POST", `${w}/agents/${agent.id}/publish`);
  // In-page actions make answers run in the background, so the visitor can keep writing meanwhile.
  const made = await o.b.call("POST", `${w}/integrations`, { agent_id: agent.id, name: "Page", mode: "in_page", base_url: "https://shop.example", tools: [{ name: "page_info", kind: "read", description: "Info.", input: { type: "object", properties: {} }, request: { method: "GET", path: "/info" } }] });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const v = browser();
  const start = (await v.call("POST", `/widget/${agent.public_key}/conversations`, {})).body;
  const vt = { "X-Visitor-Token": start.visitor_token };
  const path = `/widget/${agent.public_key}/conversations/${start.conversation_id}`;
  fakeAI.answerDelay = 300;
  try {
    const first = await v.call("POST", `${path}/messages`, { text: "What is your return policy?" }, vt);
    assert.equal(first.body.thinking, true);
    await new Promise((d) => setTimeout(d, 200));
    await v.call("POST", `${path}/typing`, {}, vt); // still typing when the answer is ready
    await new Promise((d) => setTimeout(d, 600));
    await v.call("POST", `${path}/messages`, { text: "For unworn items, the return policy?" }, vt);
    const deadline = Date.now() + 8000;
    let roles = [];
    while (Date.now() < deadline) {
      roles = (await v.call("GET", `${path}/messages`, null, vt)).body.messages.filter((m) => m.role !== "system").map((m) => m.role);
      if (roles.filter((r) => r === "ai").length >= 1 && roles.at(-1) === "ai") break;
      await new Promise((d) => setTimeout(d, 200));
    }
    await new Promise((d) => setTimeout(d, 4500)); // long enough for a held first answer to have gone out
    roles = (await v.call("GET", `${path}/messages`, null, vt)).body.messages.filter((m) => m.role !== "system").map((m) => m.role);
    assert.deepEqual(roles.slice(-3), ["visitor", "visitor", "ai"], `one answer after both messages: ${roles.join(",")}`);
  } finally {
    fakeAI.answerDelay = 0;
  }
});
