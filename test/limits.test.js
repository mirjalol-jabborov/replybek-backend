import assert from "node:assert/strict";
import { test } from "node:test";
import { owner, browser, query } from "./helpers/setup.js";

const { outbox } = await import("../src/lib/mail.js");
const period = () => new Date().toISOString().slice(0, 7);
const setUsage = (ws, messages) =>
  query("INSERT INTO usage (workspace_id, period, messages) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, period) DO UPDATE SET messages = $3, limit_emailed_at = NULL", [ws.id, period(), messages]);

test("a plan's agents are a hard limit", async () => {
  const { b, ws } = await owner();
  const w = `/w/${ws.id}`;
  assert.equal((await b.call("PATCH", `${w}/plan`, { plan: "starter" })).status, 200);
  assert.equal((await b.call("POST", `${w}/agents`, { name: "First" })).status, 201);
  const second = await b.call("POST", `${w}/agents`, { name: "Second" });
  assert.equal(second.status, 402);
  assert.equal(second.body.code, "limit_agents");
  assert.equal(second.body.limit, 1);
  assert.match(second.body.message, /includes 1 agent\./);

  // Upgrading makes room.
  await b.call("PATCH", `${w}/plan`, { plan: "growth" });
  assert.equal((await b.call("POST", `${w}/agents`, { name: "Second" })).status, 201);
});

test("a plan's knowledge sources are a hard limit across the workspace's agents", async () => {
  const { b, ws } = await owner();
  const w = `/w/${ws.id}`;
  await b.call("PATCH", `${w}/plan`, { plan: "starter" });
  const agent = (await b.call("POST", `${w}/agents`, { name: "Help" })).body;
  for (let i = 1; i <= 10; i++) {
    const r = await b.call("POST", `${w}/agents/${agent.id}/sources/qa`, { question: `Question number ${i}?`, answer: `Answer number ${i}.` });
    assert.equal(r.status, 202, JSON.stringify(r.body));
  }
  const over = await b.call("POST", `${w}/agents/${agent.id}/sources/qa`, { question: "One too many?", answer: "Yes." });
  assert.equal(over.status, 402);
  assert.equal(over.body.code, "limit_sources");
  assert.equal(over.body.limit, 10);
  assert.equal((await b.call("GET", w)).body.usage.sources, 10, "nothing was stored");
});

test("at the monthly AI message limit agents stop answering, chats go to the team, and admins get one email", async () => {
  const { b, ws, user } = await owner();
  const w = `/w/${ws.id}`;
  await b.call("PATCH", `${w}/plan`, { plan: "starter" });
  const agent = (await b.call("POST", `${w}/agents`, { name: "Help" })).body;
  await b.call("POST", `${w}/agents/${agent.id}/publish`);
  const ask = () => b.call("POST", `${w}/agents/${agent.id}/test`, { question: "Hi there" });
  const visit = async () => {
    const v = browser();
    const conv = (await v.call("POST", `/widget/${agent.public_key}/conversations`, {})).body;
    return (await v.call("POST", `/widget/${agent.public_key}/conversations/${conv.conversation_id}/messages`, { text: "Where is my order?" }, { "X-Visitor-Token": conv.visitor_token })).body.messages;
  };
  const handedOff = (messages) => messages.some((m) => m.kind === "handoff" && /can't answer right now/.test(m.body));
  const mails = () => outbox.filter((m) => m.to === user.email && /AI messages/.test(m.subject));

  // One message short: this answer is the last one, and it uses up the allowance.
  await setUsage(ws, 1999);
  assert.equal((await ask()).status, 200);
  await new Promise((r) => setTimeout(r, 100)); // the email goes out in the background
  assert.equal(mails().length, 1, "owner told once the allowance is used up");
  assert.match(mails()[0].text, /2,000 AI messages/);

  const out = await ask();
  assert.equal(out.status, 402);
  assert.equal(out.body.code, "limit_messages");
  assert.equal(out.body.limit, 2000);
  assert.match(out.body.resets_at, /^\d{4}-\d{2}-01T00:00:00\.000Z$/);
  assert.ok(handedOff(await visit()), "a website visitor reaches the team instead");
  const summary = (await b.call("GET", w)).body;
  assert.equal(summary.usage.messages, 2000, "refused answers aren't counted");

  // More answers this month don't send more emails; an upgrade turns answers back on.
  await b.call("PATCH", `${w}/plan`, { plan: "growth" });
  assert.equal((await ask()).status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(mails().length, 1);
});
