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
