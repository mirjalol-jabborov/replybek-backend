import assert from "node:assert/strict";
import { test } from "node:test";
import { owner, browser, drainJobs, query } from "./helpers/setup.js";

async function liveAgent() {
  const o = await owner();
  const w = `/w/${o.ws.id}`;
  const agent = (await o.b.call("POST", `${w}/agents`, { name: "Store Support" })).body;
  await o.b.call("POST", `${w}/agents/${agent.id}/sources/qa`, { question: "What is your return policy?", answer: "Unworn items with tags can be returned within 30 days of delivery." });
  await drainJobs();
  return { ...o, w, agent };
}

/** A website visitor talking to the widget API. */
function visitor(key, origin = "https://northstar.example") {
  const b = browser();
  let conv;
  let token;
  const h = () => ({ Origin: origin, ...(token ? { "X-Visitor-Token": token } : {}) });
  return {
    async start() {
      const r = await b.call("POST", `/widget/${key}/conversations`, { page: "/products/jacket" }, h());
      if (r.status === 201) ({ conversation_id: conv, visitor_token: token } = r.body);
      return r;
    },
    say: (text) => b.call("POST", `/widget/${key}/conversations/${conv}/messages`, { text }, h()),
    poll: () => b.call("GET", `/widget/${key}/conversations/${conv}/messages`, null, h()),
    askHuman: () => b.call("POST", `/widget/${key}/conversations/${conv}/handoff`, null, h()),
    get id() {
      return conv;
    },
    withToken: (t) => (token = t),
  };
}

test("draft agents aren't reachable from the widget; published ones are", async () => {
  const { b, w, agent } = await liveAgent();
  assert.equal((await browser().call("GET", `/widget/${agent.public_key}/config`)).status, 404);
  await b.call("POST", `${w}/agents/${agent.id}/publish`);
  const cfg = await browser().call("GET", `/widget/${agent.public_key}/config`);
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.display_name, "Northstar Outfitters");
  assert.match(cfg.body.welcome, /Store Support/);
});

test("allowed websites are enforced", async () => {
  const { b, w, agent } = await liveAgent();
  await b.call("POST", `${w}/agents/${agent.id}/publish`);
  await b.call("PATCH", `${w}/agents/${agent.id}`, { allowed_origins: ["https://northstar.example"] });
  assert.equal((await visitor(agent.public_key, "https://evil.example").start()).status, 403);
  assert.equal((await visitor(agent.public_key).start()).status, 201);
});

test("visitor → AI answer → handoff → takeover → human reply, with notes kept internal", async () => {
  const { b, w, agent, user } = await liveAgent();
  await b.call("POST", `${w}/agents/${agent.id}/publish`);
  const v = visitor(agent.public_key);
  await v.start();

  // The AI answers from knowledge, with its source.
  const first = await v.say("What's your return policy?");
  assert.equal(first.status, 200);
  const ai = first.body.messages.find((m) => m.role === "ai");
  assert.match(ai.body, /30 days/);
  assert.equal(ai.sources[0].name, "What is your return policy?");
  assert.equal(ai.kind, "answer", "the widget gets the reply type");
  assert.equal(first.body.status, "ai");

  // Asking for a person hands off and pauses the AI.
  const handoff = await v.say("Can I talk to a person please?");
  assert.equal(handoff.body.status, "needs_human");
  assert.equal(handoff.body.waiting_for_team, true);

  // The team sees it waiting, unread, with the first question as the subject.
  const waiting = (await b.call("GET", `${w}/conversations?view=needs_human`)).body;
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].unread, true);
  assert.equal(waiting[0].subject, "What's your return policy?");

  // While handed off the AI stays quiet.
  const extra = await v.say("My order is NS-10482");
  assert.deepEqual(extra.body.messages.map((m) => m.role), ["visitor"]);

  // Replying before taking over is refused.
  assert.equal((await b.call("POST", `${w}/conversations/${v.id}/reply`, { text: "Hi" })).status, 409);

  // Take over: AI paused, a summary is written, the reply duty is ours.
  const taken = (await b.call("POST", `${w}/conversations/${v.id}/takeover`)).body;
  assert.equal(taken.status, "human");
  assert.equal(taken.assignee_id, user.id);
  assert.ok(taken.summary?.length, "summary for the teammate");
  assert.equal(taken.unread, false);

  await b.call("POST", `${w}/conversations/${v.id}/note`, { text: "Check the warehouse first." });
  const replied = await b.call("POST", `${w}/conversations/${v.id}/reply`, { text: "Hi! I'm sending a replacement today." });
  assert.equal(replied.status, 200);

  // The visitor sees the human reply but never the internal note or system events.
  const seen = (await v.poll()).body;
  assert.ok(seen.messages.some((m) => m.role === "human" && /replacement/.test(m.body)));
  assert.ok(!seen.messages.some((m) => m.role === "note" || /warehouse/.test(m.body)));
  assert.ok(!seen.messages.some((m) => m.role === "system"));

  // The dashboard sees everything, in order.
  const full = (await b.call("GET", `${w}/conversations/${v.id}`)).body;
  assert.deepEqual(
    full.messages.map((m) => m.role),
    ["visitor", "ai", "visitor", "ai", "system", "visitor", "system", "note", "human"]
  );

  // Resolve; a new visitor message reopens the chat with the AI.
  assert.equal((await b.call("POST", `${w}/conversations/${v.id}/resolve`)).body.status, "resolved");
  const after = await v.say("Thanks! One more: what is the return window?");
  assert.equal(after.body.status, "ai");
  assert.ok(after.body.messages.some((m) => m.role === "ai"));
});

test("a visitor can ask for a person directly; hand back returns control to the AI", async () => {
  const { b, w, agent } = await liveAgent();
  await b.call("POST", `${w}/agents/${agent.id}/publish`);
  const v = visitor(agent.public_key);
  await v.start();
  await v.say("Hello");
  assert.equal((await v.askHuman()).body.status, "needs_human");
  await b.call("POST", `${w}/conversations/${v.id}/takeover`);
  assert.equal((await b.call("POST", `${w}/conversations/${v.id}/hand-back`)).body.status, "ai");
  assert.ok((await v.say("What is your return policy?")).body.messages.some((m) => m.role === "ai"));
});

test("a conversation can't be read with someone else's visitor token or from another workspace", async () => {
  const { b, w, agent } = await liveAgent();
  await b.call("POST", `${w}/agents/${agent.id}/publish`);
  const v = visitor(agent.public_key);
  await v.start();
  await v.say("Hello");
  const intruder = visitor(agent.public_key);
  await intruder.start();
  // Same conversation id, wrong token.
  const stolen = await browser().call("GET", `/widget/${agent.public_key}/conversations/${v.id}/messages`, null, { "X-Visitor-Token": "guess" });
  assert.equal(stolen.status, 404);
  const other = await owner("Bea", "Fernway Coffee");
  assert.equal((await other.b.call("GET", `/w/${other.ws.id}/conversations/${v.id}`)).status, 404);
  assert.equal((await other.b.call("POST", `/w/${other.ws.id}/conversations/${v.id}/takeover`)).status, 404);
});

test("assigning only works for workspace members; views filter correctly", async () => {
  const { b, w, agent, user } = await liveAgent();
  await b.call("POST", `${w}/agents/${agent.id}/publish`);
  const v = visitor(agent.public_key);
  await v.start();
  await v.say("What is your return policy?");
  const stranger = await owner("Stranger", "Other Co");
  assert.equal((await b.call("POST", `${w}/conversations/${v.id}/assign`, { user_id: stranger.user.id })).status, 400);
  assert.equal((await b.call("POST", `${w}/conversations/${v.id}/assign`, { user_id: user.id })).body.assignee_id, user.id);
  assert.equal((await b.call("GET", `${w}/conversations?view=mine`)).body.length, 1);
  assert.equal((await b.call("GET", `${w}/conversations?view=ai`)).body.length, 1);
  assert.equal((await b.call("GET", `${w}/conversations?view=resolved`)).body.length, 0);
  assert.equal((await b.call("GET", `${w}/conversations?q=return`)).body.length, 1);
  assert.equal((await b.call("GET", `${w}/conversations?q=nothing-matches`)).body.length, 0);
});

test("every AI reply counts toward the monthly message usage", async () => {
  const { b, w, agent } = await liveAgent();
  await b.call("POST", `${w}/agents/${agent.id}/publish`);
  const v = visitor(agent.public_key);
  await v.start();
  await v.say("What is your return policy?");
  await v.say("And the return window?");
  const summary = (await b.call("GET", w)).body;
  assert.equal(summary.usage.messages, 2);
  assert.equal(summary.limits.messages, 10000);
  const stored = await query("SELECT count(*)::int AS n FROM messages WHERE role = 'ai' AND workspace_id = $1", [summary.id]);
  assert.equal(stored.rows[0].n, 2);
});

test("if the AI fails, the visitor gets a polite reply and the team gets the conversation", async () => {
  const { b, w, agent } = await liveAgent();
  await b.call("POST", `${w}/agents/${agent.id}/publish`);
  const { fakeAI } = await import("../src/ai.js");
  const realEmbed = fakeAI.embed;
  fakeAI.embed = async () => {
    throw new Error("OpenAI outage");
  };
  try {
    const v = visitor(agent.public_key);
    await v.start();
    const r = await v.say("What is your return policy?");
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "needs_human");
    assert.match(r.body.messages.find((m) => m.role === "ai").body, /passed your message to the team/);
  } finally {
    fakeAI.embed = realEmbed;
  }
});
