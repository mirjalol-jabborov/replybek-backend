import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { owner, browser, drainJobs, base } from "./helpers/setup.js";

// A shop the agent can look orders up in, and change them (with Confirm).
let shop;
let shopUrl;
before(async () => {
  shop = http.createServer((req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ order_id: "4127", status: "On the way" })));
  await new Promise((done) => shop.listen(0, "127.0.0.1", done));
  shopUrl = `http://127.0.0.1:${shop.address().port}`;
});
after(() => new Promise((done) => shop.close(done)));

async function chatWithTools() {
  const o = await owner();
  const w = `/w/${o.ws.id}`;
  const agent = (await o.b.call("POST", `${w}/agents`, { name: "Shop Help" })).body;
  await o.b.call("POST", `${w}/agents/${agent.id}/sources/qa`, { question: "Do you deliver?", answer: "Yes, every weekday." });
  await drainJobs();
  await o.b.call("POST", `${w}/agents/${agent.id}/publish`);
  const made = await o.b.call("POST", `${w}/integrations`, {
    agent_id: agent.id,
    name: "Shop",
    base_url: shopUrl,
    auth: { type: "none" },
    tools: [
      { name: "get_order", description: "One order's status.", progress: "Checking your order…", input: { type: "object", properties: { order_id: { type: "string" } } }, request: { method: "GET", path: "/orders/{{args.order_id}}" } },
      { name: "change_date", kind: "write", description: "Moves a delivery.", input: { type: "object", properties: { order_id: { type: "string" } } }, request: { path: "/orders/{{args.order_id}}/date" }, confirm: { title: "Change delivery date" } },
    ],
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const v = browser();
  const start = (await v.call("POST", `/widget/${agent.public_key}/conversations`, {})).body;
  const headers = { "X-Visitor-Token": start.visitor_token };
  const path = `/widget/${agent.public_key}/conversations/${start.conversation_id}`;
  return { say: (text) => v.call("POST", `${path}/messages`, { text }, headers), streamUrl: `${base}${path}/stream`, headers };
}

/** Opens the chat's live stream and collects its `progress` events until stopped. */
async function watchProgress(url, headers) {
  const ctl = new AbortController();
  const res = await fetch(url, { headers, signal: ctl.signal });
  const reader = res.body.getReader();
  const steps = [];
  let buf = "";
  let ready;
  const isReady = new Promise((r) => (ready = r));
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += new TextDecoder().decode(value);
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (/^event: ready$/m.test(block)) ready();
          if (/^event: progress$/m.test(block)) steps.push(JSON.parse(/^data: (.*)$/m.exec(block)[1]));
        }
      }
    } catch {
      // stopped
    }
  })();
  await isReady;
  return { steps, stop: () => ctl.abort() };
}

test("while it looks something up, the chat is told what the AI is doing", async () => {
  const chat = await chatWithTools();
  const watch = await watchProgress(chat.streamUrl, chat.headers);
  const r = await chat.say('Where is 4127? [tool:get_order {"order_id":"4127"}]');
  assert.match(r.body.messages.at(-1).body, /get_order/);
  await new Promise((d) => setTimeout(d, 150));
  watch.stop();
  assert.deepEqual(watch.steps, [{ step: "tool", label: "Checking your order…" }, { step: "writing" }], "the business's own words, then writing");
});

test("a change being prepared says so; plain answers send no steps", async () => {
  const chat = await chatWithTools();
  const watch = await watchProgress(chat.streamUrl, chat.headers);
  const r = await chat.say('Move 4127 [tool:change_date {"order_id":"4127"}]');
  assert.equal(r.body.messages.at(-1).card.type, "confirm");
  await chat.say("Do you deliver?");
  await new Promise((d) => setTimeout(d, 150));
  watch.stop();
  assert.deepEqual(watch.steps, [{ step: "confirm" }, { step: "writing" }], "no steps for the answer from knowledge");
});
