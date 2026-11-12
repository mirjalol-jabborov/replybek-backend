import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { owner, browser, drainJobs, query } from "./helpers/setup.js";
import { agentTools } from "../src/services/integrations.service.js";
import { startPolling, stopPolling } from "../src/services/telegram-polling.service.js";
import { forgetOldUpdates } from "../src/services/channels.service.js";
import { fakeAI } from "../src/ai.js";

// A short burst window: messages sent within it get one answer (in production it is 1.2 s).
process.env.TELEGRAM_BURST_MS ??= "80";

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
      // A photo arrives as multipart; everything else as JSON.
      const multipart = /multipart/.test(req.headers["content-type"] || "");
      calls.push({ method, body: multipart ? { raw: body } : body ? JSON.parse(body) : {} });
      if (method === "setMyName" && JSON.parse(body).name === "Too fast")
        return res.writeHead(429, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests: retry after 540", parameters: { retry_after: 540 } }));
      if (method === "getUpdates") {
        // Each update is handed out once, so the loop doesn't answer the same message forever.
        const batch = waiting.splice(0, waiting.length);
        return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, result: batch }));
      }
      const id = (req.url.match(/\/bot(\d+):/) || [])[1];
      const result =
        method === "getMe"
          ? { id: Number(id), username: `support_bot_${id}`, first_name: "Northstar Support", can_connect_to_business: true }
          : method === "sendMessage" || method === "editMessageText"
            ? { message_id: ++messageSeq }
            : method === "getBusinessConnection"
              ? { id: JSON.parse(body).business_connection_id, user: { id: 4242, first_name: "Adam" }, user_chat_id: 4242, date: Math.floor(Date.now() / 1000) + 60, is_enabled: true, rights: { can_reply: true } }
            : method === "getMyDescription"
              ? { description: "Ask about orders and returns." }
              : method === "getMyShortDescription"
                ? { short_description: "Northstar's support" }
                : method === "getUserProfilePhotos"
                  ? { total_count: 0, photos: [] }
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
  assert.doesNotMatch(settled.body.text, /\u2014/, "no em dash in what the customer reads");
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

test("connecting a bot sets its menu: start and talk to a person, in every language", async () => {
  const o = await owner();
  const w = `/w/${o.ws.id}`;
  const agent = (await o.b.call("POST", `${w}/agents`, { name: "Menu Support" })).body;
  reset();
  await o.b.call("POST", `${w}/agents/${agent.id}/channels/telegram`, { bot_token: botToken() });
  const menus = calls.filter((c) => c.method === "setMyCommands");
  assert.ok(menus.length >= 16, "a default menu and one per language");
  assert.deepEqual(menus.find((c) => c.body.language_code === "uz").body.commands.map((x) => x.command), ["start", "operator"]);
  assert.equal(menus.find((c) => c.body.language_code === "ja").body.commands[1].description, "担当者と話す");
});

test("messages sent in a row get one answer that has read them all", async () => {
  const { channel } = await agentWithBot();
  SECRET = await secretOf(channel.id);
  const before = fakeAI.calls.chat;
  for (const part of ["Hello", "I have a question", "What is your return policy?"]) await fromTelegram(channel.id, customerSaid(6101, part));
  const answer = await until(() => sent().find((c) => /30 days/.test(c.body.text)), "the one answer");
  await new Promise((d) => setTimeout(d, 300));
  assert.equal(sent().filter((c) => String(c.body.chat_id) === "6101").length, 1, "one answer for the burst, not three");
  assert.match(answer.body.text, /30 days/);
  const { rows } = await query("SELECT m.role, m.body FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.channel_chat_id = '6101' AND m.role IN ('visitor', 'ai') ORDER BY m.seq");
  assert.deepEqual(rows.map((r) => r.role), ["visitor", "visitor", "visitor", "ai"], "every message is kept, in order");
  assert.ok(fakeAI.calls.chat - before <= 2, "the AI answered once");
});

test("/start shows the suggested questions and Talk to a person as buttons", async () => {
  const { b, w, agent, channel } = await agentWithBot();
  await b.call("PATCH", `${w}/agents/${agent.id}`, { welcome: "Hi! How can I help?", suggested_questions_i18n: { en: ["What is your return policy?"] }, suggestion_default_language: "en", welcome_i18n: { uz: "Salom!" }, handoff: true });
  SECRET = await secretOf(channel.id);
  await fromTelegram(channel.id, customerSaid(6102, "/start"));
  const welcome = await until(() => sent()[0], "the welcome");
  assert.equal(welcome.body.text, "Salom!");
  const rows = welcome.body.reply_markup.keyboard.map((row) => row[0].text);
  assert.deepEqual(rows, ["[uz] What is your return policy?", "Xodim bilan gaplashish"], "the question, translated for an Uzbek customer, then the person button");
});

test("the person button and /operator hand the chat to the team", async () => {
  const { channel } = await agentWithBot();
  SECRET = await secretOf(channel.id);
  await fromTelegram(channel.id, customerSaid(6103, "Xodim bilan gaplashish"));
  const notice = await until(() => sent()[0], "the handoff notice");
  assert.match(notice.body.text, /xodim/i);
  const { rows } = await query("SELECT status FROM conversations WHERE channel_chat_id = '6103'");
  assert.equal(rows[0].status, "needs_human");
  reset();
  await fromTelegram(channel.id, customerSaid(6104, "/operator"));
  await until(() => sent()[0], "the notice after /operator");
  assert.equal((await query("SELECT status FROM conversations WHERE channel_chat_id = '6104'")).rows[0].status, "needs_human");
});

test("an unpublished agent's bot says it isn't answering instead of going quiet", async () => {
  const { b, w, agent, channel } = await agentWithBot();
  SECRET = await secretOf(channel.id);
  await b.call("POST", `${w}/agents/${agent.id}/unpublish`);
  await fromTelegram(channel.id, customerSaid(6105, "Hello?"));
  const reply = await until(() => sent()[0], "the unavailable notice");
  assert.equal(reply.body.text, "Bu chat hozir javob bermayapti. Keyinroq qayta urinib koʻring.");
});

test("the inbox knows when a chat's bot can no longer carry replies", async () => {
  const { b, w, agent, channel } = await agentWithBot();
  SECRET = await secretOf(channel.id);
  await fromTelegram(channel.id, customerSaid(6106, "What is your return policy?"));
  await until(() => sent()[0], "the answer");
  const { rows } = await query("SELECT id FROM conversations WHERE channel_chat_id = '6106'");
  assert.equal((await b.call("GET", `${w}/conversations/${rows[0].id}`)).body.channel_status, "active");
  await b.call("DELETE", `${w}/agents/${agent.id}/channels/${channel.id}`);
  assert.equal((await b.call("GET", `${w}/conversations/${rows[0].id}`)).body.channel_status, "removed");
});

test("old update ids are forgotten; recent ones are kept", async () => {
  const { channel } = await agentWithBot();
  await query("INSERT INTO channel_updates (channel_id, update_id, received_at) VALUES ($1, 'old-1', now() - interval '3 days'), ($1, 'new-1', now())", [channel.id]);
  await forgetOldUpdates();
  const { rows } = await query("SELECT update_id FROM channel_updates WHERE channel_id = $1 ORDER BY update_id", [channel.id]);
  assert.deepEqual(rows.map((r) => r.update_id), ["new-1"]);
});

test("the greeting's buttons follow the channel's settings", async () => {
  const { b, w, agent, channel } = await agentWithBot();
  await b.call("PATCH", `${w}/agents/${agent.id}`, { welcome: "Hi!", suggested_questions_i18n: { en: ["What is your return policy?"] }, suggestion_default_language: "en", handoff: true });
  SECRET = await secretOf(channel.id);
  const bot = `${w}/agents/${agent.id}/channels/${channel.id}/bot`;

  const off = await b.call("PATCH", bot, { suggestions: false });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.deepEqual(off.body.settings, { suggestions: false, person_button: true });
  await fromTelegram(channel.id, customerSaid(6201, "/start"));
  const first = await until(() => sent()[0], "the welcome without questions");
  assert.deepEqual(first.body.reply_markup.keyboard.map((row) => row[0].text), ["Xodim bilan gaplashish"], "only the person button");

  await b.call("PATCH", bot, { person_button: false });
  reset();
  await fromTelegram(channel.id, customerSaid(6201, "/start"));
  const second = await until(() => sent()[0], "the welcome without buttons");
  assert.deepEqual(second.body.reply_markup, { remove_keyboard: true }, "buttons from the earlier greeting are taken away");
  assert.deepEqual((await b.call("GET", `${w}/agents/${agent.id}/channels`)).body[0].settings, { suggestions: false, person_button: false });
});

test("the bot's profile is read from Telegram and changed there", async () => {
  const { b, w, agent, channel, ws } = await agentWithBot();
  const bot = `${w}/agents/${agent.id}/channels/${channel.id}/bot`;
  const read = await b.call("GET", bot);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body.profile, { name: "Northstar Support", username: channel.account_name.slice(1), description: "Ask about orders and returns.", short_description: "Northstar's support", photo: null });

  reset();
  const jpeg = "data:image/jpeg;base64," + Buffer.from("not really a jpeg").toString("base64");
  const changed = await b.call("PATCH", bot, { name: "Northstar Help", description: "We answer in a minute.", short_description: "Orders, delivery, returns", photo: jpeg });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const call = (m) => calls.find((c) => c.method === m)?.body;
  assert.deepEqual(call("setMyName"), { name: "Northstar Help" });
  assert.deepEqual(call("setMyDescription"), { description: "We answer in a minute." });
  assert.deepEqual(call("setMyShortDescription"), { short_description: "Orders, delivery, returns" });
  const photo = call("setMyProfilePhoto").raw;
  assert.match(photo, /attach:\/\/upload/);
  assert.match(photo, /not really a jpeg/, "the photo itself is uploaded");
  assert.ok(!calls.some((c) => c.method === "removeMyProfilePhoto"));

  reset();
  await b.call("PATCH", bot, { remove_photo: true });
  assert.ok(calls.some((c) => c.method === "removeMyProfilePhoto"));

  // Telegram's rate limit, explained; and only JPEG photos are taken.
  const limited = await b.call("PATCH", bot, { name: "Too fast" });
  assert.equal(limited.status, 429);
  assert.match(limited.body.message, /Try again in 9 minutes/);
  assert.equal((await b.call("PATCH", bot, { photo: "data:image/png;base64,AAAA" })).status, 400);

  const { rows } = await query("SELECT count(*)::int AS n FROM activity WHERE workspace_id = $1 AND text LIKE '%changed the Telegram bot%'", [ws.id]);
  assert.ok(rows[0].n >= 1, "the change is in the activity log");
});

// ───── Telegram Business ─────

const OWNER_TG = 4242;
/** `until`, for a check that has to ask the database. */
async function eventually(check, what) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return true;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}
const businessSaid = (connection, chatId, text, from = { id: chatId, first_name: "Aziz", language_code: "uz" }, extra = {}) => ({
  business_message: { business_connection_id: connection, message_id: ++messageSeq, chat: { id: chatId, type: "private", first_name: "Aziz" }, from, text, ...extra },
});
const connectionUpdate = (id, userId, { enabled = true, canReply = true } = {}) => ({
  business_connection: { id, user: { id: userId, first_name: userId === OWNER_TG ? "Adam" : "Stranger", language_code: "en" }, user_chat_id: userId, date: Math.floor(Date.now() / 1000), is_enabled: enabled, rights: canReply ? { can_reply: true } : {} },
});

/** The owner opens the dashboard's link in their own Telegram, then adds the bot in Telegram Business. */
async function businessOwner(o) {
  const link = await o.b.call("POST", `${o.w}/agents/${o.agent.id}/channels/${o.channel.id}/business/link`);
  assert.equal(link.status, 200, JSON.stringify(link.body));
  const code = link.body.url.split("start=")[1];
  await fromTelegram(o.channel.id, { message: { chat: { id: OWNER_TG, type: "private" }, from: { id: OWNER_TG, first_name: "Adam", username: "adam_store", language_code: "en" }, text: `/start ${code}` } });
  await until(() => sent().find((c) => String(c.body.chat_id) === String(OWNER_TG)), "the owner to hear the link worked");
  await fromTelegram(o.channel.id, connectionUpdate("bc-owner", OWNER_TG));
  await until(() => sent().filter((c) => String(c.body.chat_id) === String(OWNER_TG)).length >= 2, "the owner to hear the bot is connected");
  reset();
  return code;
}

test("Telegram Business answers only for the linked owner's account, as that account", async () => {
  const o = await agentWithBot();
  const { b, w, agent, channel, ws } = o;
  SECRET = await secretOf(channel.id);
  const status = (await b.call("GET", `${w}/agents/${agent.id}/channels/${channel.id}/business`)).body;
  assert.equal(status.state, "not_linked");
  assert.equal(status.business_mode, true, "Secretary Mode in BotFather, as getMe reports it");

  // A stranger adds the bot to their own account: nothing of theirs is answered.
  await fromTelegram(channel.id, connectionUpdate("bc-stranger", 111));
  await fromTelegram(channel.id, businessSaid("bc-stranger", 9100, "What is your return policy?"));
  await new Promise((done) => setTimeout(done, 300));
  assert.equal(sent().length, 0, "a stranger's customers are not answered with this workspace's agent");

  // The owner's link: the webhook is asked for business updates, and the owner hears what to do next.
  const link = await b.call("POST", `${w}/agents/${agent.id}/channels/${channel.id}/business/link`);
  assert.match(link.body.url, /^https:\/\/t\.me\/support_bot_\d+\?start=biz_[\w-]+$/);
  const hook = calls.filter((c) => c.method === "setWebhook").pop();
  assert.ok(hook.body.allowed_updates.includes("business_message") && hook.body.allowed_updates.includes("business_connection"));
  assert.equal(hook.body.drop_pending_updates, false, "re-registering doesn't throw away waiting messages");
  const code = link.body.url.split("start=")[1];
  await fromTelegram(channel.id, { message: { chat: { id: OWNER_TG, type: "private" }, from: { id: OWNER_TG, first_name: "Adam", username: "adam_store", language_code: "en" }, text: `/start ${code}` } });
  const linked = await until(() => sent().find((c) => String(c.body.chat_id) === String(OWNER_TG)), "the owner to hear the link worked");
  assert.match(linked.body.text, /Chat Automation/, "where Telegram now keeps it");
  const afterLink = (await b.call("GET", `${w}/agents/${agent.id}/channels/${channel.id}/business`)).body;
  assert.equal(afterLink.state, "linked");
  assert.deepEqual(afterLink.owner, { name: "Adam", username: "adam_store" });

  // The same link can't be used twice, by anyone.
  reset();
  await fromTelegram(channel.id, { message: { chat: { id: 5555, type: "private" }, from: { id: 5555, first_name: "Someone", language_code: "en" }, text: `/start ${code}` } });
  const expired = await until(() => sent()[0], "the second opener to hear the link is spent");
  assert.match(expired.body.text, /expired or was already used/);

  // The owner adds the bot in Telegram Business.
  reset();
  await fromTelegram(channel.id, connectionUpdate("bc-owner", OWNER_TG));
  const connected = await until(() => sent()[0], "the owner to hear it is answering");
  assert.equal(String(connected.body.chat_id), String(OWNER_TG));
  assert.equal((await b.call("GET", `${w}/agents/${agent.id}/channels`)).body[0].business.state, "connected");

  // A customer writes to the owner's account: the answer goes out as the business, without a reply keyboard.
  reset();
  await fromTelegram(channel.id, businessSaid("bc-owner", 6101, "What is your return policy?"));
  const answer = await until(() => sent()[0], "the agent's answer in the business chat");
  assert.equal(answer.body.business_connection_id, "bc-owner");
  assert.equal(String(answer.body.chat_id), "6101");
  assert.ok(!answer.body.reply_markup, "no reply keyboard in a business chat");
  assert.ok(calls.some((c) => c.method === "sendChatAction" && c.body.business_connection_id === "bc-owner"), "the dots show as the business");
  const conv = (await query("SELECT * FROM conversations WHERE workspace_id = $1 AND channel = 'telegram_business'", [ws.id])).rows[0];
  assert.equal(conv.channel_chat_id, "biz:6101");
  assert.equal(conv.visitor.name, "Aziz");

  // The same person writing to the bot itself is a different chat.
  reset();
  await fromTelegram(channel.id, customerSaid(6101, "Hello"));
  await until(() => sent()[0], "the bot's own answer");
  assert.equal((await query("SELECT count(*)::int AS n FROM conversations WHERE workspace_id = $1", [ws.id])).rows[0].n, 2);

  // What the bot sent comes back as an update; it is already in the inbox.
  const before = (await query("SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1", [conv.id])).rows[0].n;
  await fromTelegram(channel.id, businessSaid("bc-owner", 6101, answer.body.text, { id: OWNER_TG, first_name: "Adam" }, { sender_business_bot: { id: 1, is_bot: true } }));
  await new Promise((done) => setTimeout(done, 200));
  assert.equal((await query("SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1", [conv.id])).rows[0].n, before);

  // The owner writes from their phone: it goes in the transcript, and the AI steps back in that chat.
  await fromTelegram(channel.id, businessSaid("bc-owner", 6101, "Hi Aziz, Adam here. Which size?", { id: OWNER_TG, first_name: "Adam" }));
  await eventually(async () => (await query("SELECT status FROM conversations WHERE id = $1", [conv.id])).rows[0].status === "human", "the chat to be the owner's");
  await new Promise((done) => setTimeout(done, 100));
  const { rows: said } = await query("SELECT role, body, author_id FROM messages WHERE conversation_id = $1 AND role = 'human'", [conv.id]);
  assert.equal(said[0].body, "Hi Aziz, Adam here. Which size?");
  assert.equal(said[0].author_id, o.user.id, "the reply is the member who linked the account");
  reset();
  await fromTelegram(channel.id, businessSaid("bc-owner", 6101, "Size M please"));
  await new Promise((done) => setTimeout(done, 400));
  assert.equal(sent().length, 0, "the AI doesn't answer over the owner");
});

test("Telegram Business: Confirm works in a business chat, and replies stop once the owner removes the bot", async () => {
  const o = await agentWithBot();
  const { b, w, agent, channel } = o;
  SECRET = await secretOf(channel.id);
  await businessOwner(o);
  const made = await b.call("POST", `${w}/integrations`, shopIntegration(agent.id, "server"));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const before = placed.length;

  await fromTelegram(channel.id, businessSaid("bc-owner", 7101, '[tool:place_order {"items":[{"product":"Boots","quantity":1}]}]'));
  const card = await until(() => sent().find((c) => c.body.reply_markup), "the confirmation buttons");
  assert.equal(card.body.business_connection_id, "bc-owner");
  const [confirm] = card.body.reply_markup.inline_keyboard[0];
  reset();
  await fromTelegram(channel.id, { callback_query: { id: "cb-b1", data: confirm.callback_data, message: { message_id: 1, business_connection_id: "bc-owner", chat: { id: 7101, type: "private" } }, from: { id: 7101 } } });
  await until(() => placed.length > before, "the order to be placed");
  const settled = await until(() => calls.find((c) => c.method === "editMessageText"), "the buttons to be replaced");
  assert.equal(settled.body.business_connection_id, "bc-owner");

  // A tap can only decide a card from its own chat.
  const conv = (await query("SELECT * FROM conversations WHERE channel_id = $1 AND channel_chat_id = 'biz:7101'", [channel.id])).rows[0];
  const { rows: cards } = await query("SELECT id FROM pending_actions WHERE conversation_id = $1", [conv.id]);
  assert.equal(cards.length, 1);

  // The owner removes the bot in Telegram: the inbox says replies can't reach the customer, and none are sent.
  await fromTelegram(channel.id, connectionUpdate("bc-owner", OWNER_TG, { enabled: false }));
  await eventually(async () => (await b.call("GET", `${w}/agents/${agent.id}/channels`)).body[0].business.state === "linked", "the connection to be gone");
  const shown = (await b.call("GET", `${w}/conversations/${conv.id}`)).body;
  assert.equal(shown.channel_status, "disabled");
  assert.ok(new Date(shown.reply_until) > new Date(), "Telegram's 24-hour window, from the customer's last message");
  await b.call("POST", `${w}/conversations/${conv.id}/takeover`);
  reset();
  await b.call("POST", `${w}/conversations/${conv.id}/reply`, { text: "Your boots are on the way." });
  await new Promise((done) => setTimeout(done, 200));
  assert.equal(sent().length, 0);

  // Turning it off in Replybek forgets the account.
  const off = await b.call("DELETE", `${w}/agents/${agent.id}/channels/${channel.id}/business`);
  assert.equal(off.body.state, "not_linked");
});

test("Telegram Business: a draft agent stays out of the owner's chats", async () => {
  const o = await agentWithBot();
  SECRET = await secretOf(o.channel.id);
  await businessOwner(o);
  await o.b.call("POST", `${o.w}/agents/${o.agent.id}/unpublish`);
  await fromTelegram(o.channel.id, businessSaid("bc-owner", 7201, "Hello?"));
  await new Promise((done) => setTimeout(done, 300));
  assert.equal(sent().length, 0, "no 'not answering' note on the owner's behalf: the customer is writing to a person");
});

test("reconnecting the same bot keeps its button settings and its Telegram Business link", async () => {
  const o = await agentWithBot();
  SECRET = await secretOf(o.channel.id);
  await businessOwner(o);
  await o.b.call("PATCH", `${o.w}/agents/${o.agent.id}/channels/${o.channel.id}/bot`, { suggestions: false });
  const again = await o.b.call("POST", `${o.w}/agents/${o.agent.id}/channels/telegram`, { bot_token: o.token });
  assert.equal(again.status, 201);
  assert.equal(again.body.business.state, "connected");
  assert.equal(again.body.settings.suggestions, false);
  assert.notEqual(await secretOf(o.channel.id), SECRET, "the webhook secret is new");
});

test("a resolved chat the customer wrote to again points to the newer one, and can't be reopened beside it", async () => {
  const { b, w, ws, channel } = await agentWithBot();
  SECRET = await secretOf(channel.id);
  await fromTelegram(channel.id, customerSaid(8101, "What is your return policy?"));
  await until(() => sent()[0], "the first answer");
  const first = (await query("SELECT id FROM conversations WHERE workspace_id = $1", [ws.id])).rows[0];
  // Taking over twice notes it once.
  await b.call("POST", `${w}/conversations/${first.id}/takeover`);
  await b.call("POST", `${w}/conversations/${first.id}/takeover`);
  const { rows: notes } = await query("SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND role = 'system' AND body LIKE '%took over%'", [first.id]);
  assert.equal(notes[0].n, 1);
  await b.call("POST", `${w}/conversations/${first.id}/resolve`);

  reset();
  await fromTelegram(channel.id, customerSaid(8101, "And one more question"));
  await until(() => sent()[0], "the answer in a new conversation");
  const newer = (await query("SELECT id FROM conversations WHERE workspace_id = $1 AND id <> $2", [ws.id, first.id])).rows[0];
  const old = (await b.call("GET", `${w}/conversations/${first.id}`)).body;
  assert.equal(old.open_conversation_id, newer.id);
  const reopened = await b.call("POST", `${w}/conversations/${first.id}/reopen`);
  assert.equal(reopened.status, 409, "not a server error");
  assert.equal(reopened.body.open_conversation_id, newer.id);
});

test("Telegram Business: turning it off and linking again finds the bot still connected; an unknown connection is looked up", async () => {
  const o = await agentWithBot();
  SECRET = await secretOf(o.channel.id);
  await businessOwner(o);
  const status = () => o.b.call("GET", `${o.w}/agents/${o.agent.id}/channels/${o.channel.id}/business`).then((r) => r.body.state);
  await o.b.call("DELETE", `${o.w}/agents/${o.agent.id}/channels/${o.channel.id}/business`);
  assert.equal(await status(), "not_linked");
  // The same account links again; Telegram doesn't report the connection again, and needn't.
  const link = await o.b.call("POST", `${o.w}/agents/${o.agent.id}/channels/${o.channel.id}/business/link`);
  await fromTelegram(o.channel.id, { message: { chat: { id: OWNER_TG, type: "private" }, from: { id: OWNER_TG, first_name: "Adam", language_code: "en" }, text: `/start ${link.body.url.split("start=")[1]}` } });
  const told = await until(() => sent().find((c) => String(c.body.chat_id) === String(OWNER_TG)), "the owner to hear it");
  assert.match(told.body.text, /answers your customers/, "connected straight away");
  assert.equal(await status(), "connected");

  // A message through a connection Replybek never heard of: it asks Telegram, and answers.
  reset();
  await fromTelegram(o.channel.id, businessSaid("bc-unheard", 7301, "What is your return policy?"));
  const answer = await until(() => sent().find((c) => c.body.business_connection_id === "bc-unheard"), "an answer through the looked-up connection");
  assert.equal(String(answer.body.chat_id), "7301");
  assert.ok(calls.some((c) => c.method === "getBusinessConnection"));
});
