import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { owner, browser, drainJobs, query } from "./helpers/setup.js";
import { agentTools } from "../src/services/integrations.service.js";
import { startPolling, stopPolling } from "../src/services/telegram-polling.service.js";

/**
 * The Telegram channel: connecting a bot, what arrives from a customer, and what is sent back.
 * Telegram itself is replaced by a server that records every call, so the tests assert on what
 * the customer would actually receive.
 */

// One bot belongs to one agent, so each test connects a bot of its own.
let botSeq = 0;
const botToken = () => `${770000 + ++botSeq}:AAEhBOweik6ad9r_TestTokenForThisSuite01`;
let telegram;
let calls = [];
let messageSeq = 0;
// A stand-in for the business system an agent acts in, so a confirmed change has a real effect.
let waiting = [];
let shop;
let shopUrl;
const placed = [];

before(async () => {
  telegram = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const method = req.url.split("/").pop();
      calls.push({ method, body: body ? JSON.parse(body) : {} });
      if (method === "getUpdates") {
        // Each update is handed out once, so the loop doesn't answer the same message forever.
        const batch = waiting.splice(0, waiting.length);
        return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, result: batch }));
      }
      const id = (req.url.match(/\/bot(\d+):/) || [])[1];
      const result =
        method === "getMe"
          ? { id: Number(id), username: `support_bot_${id}`, first_name: "Northstar Support" }
          : method === "sendMessage" || method === "editMessageText"
            ? { message_id: ++messageSeq }
            : true;
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise((done) => telegram.listen(0, "127.0.0.1", done));
  process.env.TELEGRAM_API = `http://127.0.0.1:${telegram.address().port}`;

  shop = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url === "/orders:create") placed.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ order_id: 4127, orders: [] }));
    });
  });
  await new Promise((done) => shop.listen(0, "127.0.0.1", done));
  shopUrl = `http://127.0.0.1:${shop.address().port}`;
});

after(async () => {
  await new Promise((done) => telegram.close(done));
  await new Promise((done) => shop.close(done));
});

const sent = () => calls.filter((c) => c.method === "sendMessage");
const reset = () => (calls = []);

/** Waits for the fire-and-forget handling of an update to reach Telegram. */
async function until(check, what, tries = 100) {
  for (let i = 0; i < tries; i++) {
    const found = check();
    if (found) return found;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`Timed out waiting for ${what}. Calls so far: ${calls.map((c) => c.method).join(", ")}`);
}

/** A published agent that knows one thing, with a Telegram bot connected to it. */
async function agentWithBot() {
  const o = await owner();
  const w = `/w/${o.ws.id}`;
  const agent = (await o.b.call("POST", `${w}/agents`, { name: "Store Support" })).body;
  await o.b.call("POST", `${w}/agents/${agent.id}/sources/qa`, { question: "What is your return policy?", answer: "Unworn items with tags can be returned within 30 days of delivery." });
  await drainJobs();
  await o.b.call("POST", `${w}/agents/${agent.id}/publish`);
  const token = botToken();
  const connected = await o.b.call("POST", `${w}/agents/${agent.id}/channels/telegram`, { bot_token: token });
  assert.equal(connected.status, 201, JSON.stringify(connected.body));
  reset();
  return { ...o, w, agent, token, channel: connected.body };
}

/** Telegram delivering an update to the webhook, the way it would in production. */
let updateSeq = 0;
function fromTelegram(channelId, update, secret) {
  return browser().call("POST", `/channels/telegram/${channelId}`, { update_id: ++updateSeq, ...update }, { "X-Telegram-Bot-Api-Secret-Token": secret ?? SECRET });
}

let SECRET;
async function secretOf(channelId) {
  const { rows } = await query("SELECT config->>'secret' AS secret FROM agent_channels WHERE id = $1", [channelId]);
  return rows[0].secret;
}

const customerSaid = (chatId, text) => ({ message: { chat: { id: chatId, type: "private" }, from: { id: chatId, first_name: "Dilnoza", language_code: "uz" }, text } });

test("connecting a bot checks the token, registers the webhook and never returns it", async () => {
  const { b, w, agent, channel, token } = await agentWithBot();
  assert.match(channel.account_name, /^@support_bot_\d+$/);
  assert.equal(channel.status, "active");
  assert.equal(channel.token, undefined, "credentials never leave the server");

  const listed = await b.call("GET", `${w}/agents/${agent.id}/channels`);
  assert.equal(listed.body.length, 1);
  assert.equal(listed.body[0].account_name, channel.account_name);

  const stored = (await query("SELECT config FROM agent_channels WHERE id = $1", [channel.id])).rows[0].config;
  assert.ok(stored.token.startsWith("v1."), "the token is encrypted at rest");
  assert.ok(!JSON.stringify(stored).includes(token));

  const bad = await b.call("POST", `${w}/agents/${agent.id}/channels/telegram`, { bot_token: "not-a-token" });
  assert.equal(bad.status, 400);
});

test("the same bot cannot answer for two workspaces, and reconnecting it to its own is fine", async () => {
  const { b, w, agent, token, channel } = await agentWithBot();
  const again = await b.call("POST", `${w}/agents/${agent.id}/channels/telegram`, { bot_token: token });
  assert.equal(again.status, 201, "reconnecting the same bot here just refreshes it");
  assert.equal(again.body.id, channel.id);

  const other = await owner();
  const ow = `/w/${other.ws.id}`;
  const theirs = (await other.b.call("POST", `${ow}/agents`, { name: "Other support" })).body;
  const taken = await other.b.call("POST", `${ow}/agents/${theirs.id}/channels/telegram`, { bot_token: token });
  assert.equal(taken.status, 409);
  assert.match(taken.body.message, /another workspace/);
});

test("the webhook only answers to the channel's own secret", async () => {
  const { channel } = await agentWithBot();
  SECRET = await secretOf(channel.id);
  assert.equal((await fromTelegram(channel.id, customerSaid(5001, "Hello"), "guessed")).status, 401);
  assert.equal((await fromTelegram(channel.id, customerSaid(5001, "Hello"), undefined)).status, 200);
});

test("a customer's message opens one conversation and is answered in the chat", async () => {
  const { ws, channel } = await agentWithBot();
  SECRET = await secretOf(channel.id);
  await fromTelegram(channel.id, customerSaid(6001, "What is your return policy?"));
  const reply = await until(() => sent()[0], "an answer to the customer");
  assert.equal(String(reply.body.chat_id), "6001");
  assert.ok(reply.body.text.length > 0);
  assert.ok(calls.some((c) => c.method === "sendChatAction"), "the customer sees the three dots while it is written");

  const { rows } = await query("SELECT * FROM conversations WHERE workspace_id = $1", [ws.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, "telegram");
  assert.equal(rows[0].channel_chat_id, "6001");
  assert.equal(rows[0].visitor.language, "uz", "the customer's own language, from Telegram");
  assert.equal(rows[0].visitor.name, "Dilnoza");

  // A second message continues the same conversation rather than starting another.
  reset();
  await fromTelegram(channel.id, customerSaid(6001, "And for shoes?"));
  await until(() => sent()[0], "a second answer");
  assert.equal((await query("SELECT count(*)::int AS n FROM conversations WHERE workspace_id = $1", [ws.id])).rows[0].n, 1);
});

test("a redelivered update is not answered twice", async () => {
  const { channel } = await agentWithBot();
  SECRET = await secretOf(channel.id);
  const update = { update_id: 999001, ...customerSaid(6002, "What is your return policy?") };
  const post = () => browser().call("POST", `/channels/telegram/${channel.id}`, update, { "X-Telegram-Bot-Api-Secret-Token": SECRET });
  await post();
  await until(() => sent()[0], "the first answer");
  const before = sent().length;
  assert.equal((await post()).status, 200, "a repeat is still acknowledged, so Telegram stops retrying");
  await new Promise((done) => setTimeout(done, 200));
  assert.equal(sent().length, before, "but the customer is not written to again");
});

test("/start sends the welcome in the customer's language", async () => {
  const { b, w, agent, channel } = await agentWithBot();
  await b.call("PATCH", `${w}/agents/${agent.id}`, { welcome: "Hi! How can I help?", welcome_i18n: { uz: "Salom! Qanday yordam bera olaman?" } });
  SECRET = await secretOf(channel.id);
  await fromTelegram(channel.id, customerSaid(6003, "/start"));
  const welcome = await until(() => sent()[0], "the welcome");
  assert.equal(welcome.body.text, "Salom! Qanday yordam bera olaman?");
});

test("a teammate's reply from the inbox reaches the customer in Telegram", async () => {
  const { b, w, ws, channel } = await agentWithBot();
  SECRET = await secretOf(channel.id);
  await fromTelegram(channel.id, customerSaid(6004, "I want to talk to a person"));
  await until(() => sent()[0], "the agent's answer");
  const conv = (await query("SELECT id FROM conversations WHERE workspace_id = $1", [ws.id])).rows[0];

  await b.call("POST", `${w}/conversations/${conv.id}/takeover`);
  reset();
  const replied = await b.call("POST", `${w}/conversations/${conv.id}/reply`, { text: "Hi, this is Alex. I can help with that." });
  assert.equal(replied.status, 200, JSON.stringify(replied.body));
  const message = await until(() => sent()[0], "the teammate's reply");
  assert.equal(message.body.text, "Hi, this is Alex. I can help with that.");
  assert.equal(String(message.body.chat_id), "6004");
});

test("disconnecting removes the webhook and the channel", async () => {
  const { b, w, agent, channel } = await agentWithBot();
  const gone = await b.call("DELETE", `${w}/agents/${agent.id}/channels/${channel.id}`);
  assert.equal(gone.status, 200);
  assert.ok(calls.some((c) => c.method === "deleteWebhook"));
  assert.deepEqual((await b.call("GET", `${w}/agents/${agent.id}/channels`)).body, []);
  SECRET = await secretOf(channel.id).catch(() => "none");
  assert.equal((await fromTelegram(channel.id, customerSaid(6005, "Hello"), "none")).status, 401);
});

/** One action the agent can take in a business system, as a tool of the given mode. */
const shopIntegration = (agentId, mode) => ({
  agent_id: agentId,
  name: "Shop",
  mode,
  base_url: shopUrl,
  auth: { type: "none" },
  tools: [
    {
      name: "place_order",
      kind: "write",
      description: "Places an order for the customer.",
      input: { type: "object", properties: { items: { type: "array" } }, required: ["items"] },
      request: { path: "/orders:create", body: { items: { $each: "{{args.items}}", do: { product: "{{item.product}}", quantity: "{{item.quantity | number}}" } } } },
      response: { type: "json", pick: "order_id" },
      confirm: { title: "New order", lines: { $each: "{{args.items}}", do: ["{{item.product}}", "× {{item.quantity}}"] } },
    },
  ],
});

test("a change is proposed as Confirm and Cancel buttons, in the customer's language, and runs only when tapped", async () => {
  const { b, w, agent, channel } = await agentWithBot();
  const made = await b.call("POST", `${w}/integrations`, shopIntegration(agent.id, "server"));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  SECRET = await secretOf(channel.id);
  const before = placed.length;

  await fromTelegram(channel.id, customerSaid(7001, '[tool:place_order {"items":[{"product":"Jacket","quantity":2}]}]'));
  const card = await until(() => sent().find((c) => c.body.reply_markup), "the confirmation buttons");
  const [confirm, cancel] = card.body.reply_markup.inline_keyboard[0];
  assert.equal(confirm.text, "Tasdiqlash", "the buttons are in the language the customer writes in");
  assert.equal(cancel.text, "Bekor qilish");
  assert.match(card.body.text, /New order/);
  assert.match(card.body.text, /Jacket/);
  assert.equal(placed.length, before, "nothing happens before the customer confirms");

  reset();
  await fromTelegram(channel.id, { callback_query: { id: "cb-1", data: confirm.callback_data, message: { message_id: 1, chat: { id: 7001, type: "private" } }, from: { id: 7001 } } });
  await until(() => placed.length > before, "the order to be placed");
  assert.deepEqual(placed[placed.length - 1], { items: [{ product: "Jacket", quantity: 2 }] });
  assert.ok(calls.some((c) => c.method === "answerCallbackQuery"), "the tapped button stops spinning");
  const settled = await until(() => calls.find((c) => c.method === "editMessageText"), "the buttons to be replaced");
  assert.match(settled.body.text, /Tasdiqlandi/, "the card says what happened and can't be tapped again");
  await until(() => sent()[0], "the outcome in words");
});

test("actions that run inside the customer's own browser are never offered on Telegram", async () => {
  const { b, w, agent, channel } = await agentWithBot();
  const made = await b.call("POST", `${w}/integrations`, shopIntegration(agent.id, "in_page"));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal((await agentTools(agent.id, "widget")).length, 1, "the widget has the action");
  assert.equal((await agentTools(agent.id, "telegram")).length, 0, "Telegram has no session to act in");

  SECRET = await secretOf(channel.id);
  const before = placed.length;
  await fromTelegram(channel.id, customerSaid(7002, '[tool:place_order {"items":[{"product":"Jacket","quantity":2}]}]'));
  const reply = await until(() => sent()[0], "an answer without the action");
  assert.ok(!reply.body.reply_markup, "no confirmation is offered");
  assert.equal(placed.length, before);
});

test("without a public address the bot asks Telegram for its updates, and answers the same way", async () => {
  const { channel } = await agentWithBot();
  // What a laptop looks like: Telegram cannot call in, so the bot collects its own updates.
  waiting.push({ update_id: 880001, ...customerSaid(9001, "What is your return policy?") });
  startPolling(channel.id);
  try {
    const reply = await until(() => sent()[0], "an answer collected without a webhook");
    assert.equal(String(reply.body.chat_id), "9001");
    const { rows } = await query("SELECT channel, channel_chat_id FROM conversations WHERE channel_chat_id = $1", ["9001"]);
    assert.equal(rows[0].channel, "telegram");
    assert.ok(calls.some((c) => c.method === "getUpdates"));
  } finally {
    stopPolling(channel.id);
  }
});
