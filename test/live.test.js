import assert from "node:assert/strict";
import { test } from "node:test";
import { owner, browser, drainJobs, base } from "./helpers/setup.js";

async function liveAgent() {
  const o = await owner();
  const w = `/w/${o.ws.id}`;
  const agent = (await o.b.call("POST", `${w}/agents`, { name: "Store Support" })).body;
  await o.b.call("POST", `${w}/agents/${agent.id}/sources/qa`, { question: "What is your return policy?", answer: "Unworn items with tags can be returned within 30 days of delivery." });
  await drainJobs();
  await o.b.call("POST", `${w}/agents/${agent.id}/publish`);
  return { ...o, w, agent };
}

/** Opens an event stream like a browser does and collects what arrives. */
async function openStream(path, headers = {}) {
  const ctl = new AbortController();
  const res = await fetch(base + path, { headers: { "CF-Connecting-IP": "198.51.100.7", ...headers }, signal: ctl.signal });
  const events = [];
  let wake = () => {};
  if (res.ok) {
    (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1] || "message";
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (data !== undefined) events.push({ event, data: JSON.parse(data), at: Date.now() });
            wake();
          }
        }
      } catch {
        // aborted
      }
    })();
  }
  return {
    status: res.status,
    type: res.headers.get("content-type"),
    events,
    /** Resolves with the first event matching `match` (from index `from`), or null after `ms`. */
    async next(match, ms = 3000, from = 0) {
      const end = Date.now() + ms;
      for (;;) {
        const hit = events.slice(from).find(match);
        if (hit) return hit;
        if (Date.now() > end) return null;
        await new Promise((r) => {
          wake = r;
          setTimeout(r, 50);
        });
      }
    },
    close: () => ctl.abort(),
  };
}

const about = (id) => (e) => e.event === "message" && e.data.c?.includes(id);

test("the widget hears a teammate's reply the moment it's sent, only with its own token", async () => {
  const { b, w, agent } = await liveAgent();
  const site = { Origin: "https://northstar.example" };
  const visitor = browser();
  const { conversation_id: id, visitor_token: token } = (await visitor.call("POST", `/widget/${agent.public_key}/conversations`, { page: "/" }, site)).body;
  await visitor.call("POST", `/widget/${agent.public_key}/conversations/${id}/handoff`, null, { ...site, "X-Visitor-Token": token });

  const stolen = await openStream(`/widget/${agent.public_key}/conversations/${id}/stream`, { ...site, "X-Visitor-Token": "guess" });
  assert.equal(stolen.status, 404, "someone else's conversation can't be watched");

  const s = await openStream(`/widget/${agent.public_key}/conversations/${id}/stream`, { ...site, "X-Visitor-Token": token });
  try {
    assert.equal(s.status, 200);
    assert.match(s.type, /^text\/event-stream/);
    assert.ok(await s.next((e) => e.event === "ready"), "the stream says when it's listening");

    await b.call("POST", `${w}/conversations/${id}/takeover`);
    const from = s.events.length;
    const sent = Date.now();
    await b.call("POST", `${w}/conversations/${id}/reply`, { text: "Hi! Checking now." });
    const heard = await s.next(about(id), 3000, from);
    assert.ok(heard, "the reply is announced");
    assert.ok(heard.at - sent < 1000, `announced within a second (${heard.at - sent} ms)`);
    assert.deepEqual(Object.keys(heard.data), ["c"], "events carry ids only, never message text");

    const messages = (await visitor.call("GET", `/widget/${agent.public_key}/conversations/${id}/messages`, null, { ...site, "X-Visitor-Token": token })).body.messages;
    assert.ok(messages.some((m) => m.role === "human" && /Checking now/.test(m.body)));
  } finally {
    s.close();
  }
});

test("the inbox hears new chats in its own workspace and nothing from others", async () => {
  const { b, w, agent, ws } = await liveAgent();
  const other = await owner();

  assert.equal((await openStream(`${w}/stream`)).status, 401, "signed-out browsers can't listen");
  assert.equal((await openStream(`${w}/stream`, { Cookie: other.b.cookie })).status, 404, "nor can another workspace");

  const mine = await openStream(`${w}/stream`, { Cookie: b.cookie });
  const theirs = await openStream(`/w/${other.ws.id}/stream`, { Cookie: other.b.cookie });
  try {
    assert.ok(await mine.next((e) => e.event === "ready"));
    assert.ok(await theirs.next((e) => e.event === "ready"));
    const visitor = browser();
    const site = { Origin: "https://northstar.example" };
    const { conversation_id: id, visitor_token: token } = (await visitor.call("POST", `/widget/${agent.public_key}/conversations`, { page: "/" }, site)).body;
    await visitor.call("POST", `/widget/${agent.public_key}/conversations/${id}/messages`, { text: "What is your return policy?" }, { ...site, "X-Visitor-Token": token });
    assert.ok(await mine.next(about(id)), "the new chat is announced to its workspace");
    assert.equal(await theirs.next((e) => e.event === "message", 500), null, "and to no one else");
    assert.ok(ws.id);
  } finally {
    mine.close();
    theirs.close();
  }
});

// ───── Typing and presence ─────

async function visitorChat(agent, extra = {}) {
  const site = { Origin: "https://northstar.example" };
  const v = browser();
  const start = await v.call("POST", `/widget/${agent.public_key}/conversations`, { page: "/", ...extra }, site);
  const { conversation_id: id, visitor_token: token } = start.body;
  const as = { ...site, "X-Visitor-Token": token };
  const post = (p, body) => v.call("POST", `/widget/${agent.public_key}/conversations/${id}${p}`, body, as);
  return { id, token, as, post };
}

test("typing shows on the other side at once, and only where it should", async () => {
  const { b, w, agent, user } = await liveAgent();
  const chat = await visitorChat(agent);
  const dash = await openStream(`${w}/stream`, { Cookie: b.cookie });
  await dash.next((e) => e.event === "ready");

  // The visitor types: the team's open Inbox hears which conversation.
  assert.equal((await chat.post("/typing")).status, 200);
  const typing = await dash.next((e) => e.event === "typing");
  assert.deepEqual(typing?.data, { c: chat.id, who: "visitor" });

  // A teammate types: only once they're handling the chat, and only that visitor hears it.
  const widget = await openStream(`/widget/${agent.public_key}/conversations/${chat.id}/stream`, chat.as);
  await widget.next((e) => e.event === "ready");
  assert.deepEqual((await b.call("POST", `${w}/conversations/${chat.id}/typing`)).body, { ok: false }, "the AI is handling it");
  await chat.post("/handoff");
  await b.call("POST", `${w}/conversations/${chat.id}/takeover`);
  assert.deepEqual((await b.call("POST", `${w}/conversations/${chat.id}/typing`)).body, { ok: true });
  const team = await widget.next((e) => e.event === "typing");
  assert.deepEqual(team?.data, { who: "team", name: user.name.split(" ")[0] });

  const other = await visitorChat(agent);
  const elsewhere = await openStream(`/widget/${agent.public_key}/conversations/${other.id}/stream`, other.as);
  await elsewhere.next((e) => e.event === "ready");
  await b.call("POST", `${w}/conversations/${chat.id}/typing`);
  assert.equal(await elsewhere.next((e) => e.event === "typing", 400), null, "another visitor doesn't hear it");
  for (const s of [dash, widget, elsewhere]) s.close();
});

test("the team sees whether the visitor is still there, and follows them into a new chat", async () => {
  const { b, w, agent } = await liveAgent();
  const chat = await visitorChat(agent);
  const seen = async (id) => (await b.call("GET", `${w}/conversations/${id}`)).body;
  const first = await seen(chat.id);
  assert.ok(first.visitor_seen_at, "starting the chat counts as being here");
  assert.ok(Math.abs(Date.parse(first.server_now) - Date.parse(first.visitor_seen_at)) < 5000);
  assert.equal((await chat.post("/presence")).status, 200);
  const listed = (await b.call("GET", `${w}/conversations?view=all`)).body.find((c) => c.id === chat.id);
  assert.ok(listed.visitor_seen_at && listed.server_now, "the list has it too");

  // "Start a new chat": the old one says so, and the two are linked.
  await chat.post("/messages", { text: "Hello" });
  assert.equal((await chat.post("/leave")).status, 200);
  assert.equal((await chat.post("/leave")).status, 200, "leaving twice is fine");
  const left = await seen(chat.id);
  assert.ok(left.left_at);
  assert.equal(left.messages.filter((m) => m.role === "system" && m.body === "Visitor started a new chat").length, 1);

  const next = await visitorChat(agent, { previous: { id: chat.id, token: chat.token } });
  assert.equal((await seen(next.id)).previous_id, chat.id);
  assert.equal((await seen(chat.id)).continued_in, next.id);
  const forged = await visitorChat(agent, { previous: { id: next.id, token: "not-the-real-token" } });
  assert.equal((await seen(forged.id)).previous_id, null, "a chat is only linked with its own token");
  assert.equal((await seen(next.id)).continued_in, null);
  const site = { Origin: "https://northstar.example" };
  assert.equal((await browser().call("POST", `/widget/${agent.public_key}/conversations/${chat.id}/presence`, null, { ...site, "X-Visitor-Token": "guess" })).status, 404);
});

test("a signed-in page tells the chat who the visitor is", async () => {
  const { b, w, agent } = await liveAgent();
  const chat = await visitorChat(agent);
  assert.equal((await chat.post("/visitor", { name: "Dilnoza Karimova", email: "dilnoza@shop.uz" })).status, 200);
  const conv = (await b.call("GET", `${w}/conversations/${chat.id}`)).body;
  assert.equal(conv.visitor.name, "Dilnoza Karimova");
  assert.equal(conv.visitor.email, "dilnoza@shop.uz");
  assert.equal(conv.visitor.page, "/", "what the chat already knew stays");
  assert.equal((await chat.post("/visitor", { email: "not an email" })).status, 400);
  const site = { Origin: "https://northstar.example" };
  assert.equal((await browser().call("POST", `/widget/${agent.public_key}/conversations/${chat.id}/visitor`, { name: "Someone else" }, { ...site, "X-Visitor-Token": "guess" })).status, 404, "only with the chat's token");
});
