import assert from "node:assert/strict";
import { test } from "node:test";
import { owner, browser, drainJobs } from "./helpers/setup.js";

test("analytics counts conversations, escalations and unanswered questions", async () => {
  const { b, ws } = await owner();
  const w = `/w/${ws.id}`;
  const agent = (await b.call("POST", `${w}/agents`, { name: "Store Support" })).body;
  await b.call("POST", `${w}/agents/${agent.id}/sources/qa`, { question: "What is your return policy?", answer: "30 days for unworn items." });
  await drainJobs();
  await b.call("POST", `${w}/agents/${agent.id}/publish`);
  const chat = async (text) => {
    const v = browser();
    const s = await v.call("POST", `/widget/${agent.public_key}/conversations`, {});
    await v.call("POST", `/widget/${agent.public_key}/conversations/${s.body.conversation_id}/messages`, { text }, { "X-Visitor-Token": s.body.visitor_token });
  };
  await chat("What is your return policy?");
  await chat("Can I talk to a person?");
  await chat("Do you sell gift cards?");
  // A chat that was opened but never used doesn't count.
  await browser().call("POST", `/widget/${agent.public_key}/conversations`, {});

  const r = (await b.call("GET", `${w}/analytics?days=7`)).body;
  assert.equal(r.total, 3);
  assert.equal(r.escalated, 1);
  assert.equal(r.by_ai, 2);
  assert.equal(r.open_unanswered, 1);
  assert.equal(r.series.length, 7);
  assert.equal(r.series.at(-1).total, 3, "today is the last day in the series");
  assert.equal((await b.call("GET", `${w}/analytics?days=12`)).status, 400);
  assert.equal((await b.call("GET", `${w}/analytics?days=30&agent=all`)).body.total, 3);

  // Deleting an irrelevant question hides it for good, even when it's asked again.
  const [q] = (await b.call("GET", `${w}/unanswered`)).body;
  assert.equal((await b.call("DELETE", `${w}/unanswered/${q.id}`)).status, 204);
  assert.equal((await b.call("GET", `${w}/unanswered`)).body.length, 0);
  assert.equal((await b.call("GET", `${w}/analytics?days=7`)).body.open_unanswered, 0);
  await chat("Do you sell gift cards?");
  assert.equal((await b.call("GET", `${w}/unanswered`)).body.length, 0);
  assert.equal((await b.call("DELETE", `${w}/unanswered/${q.id}`)).status, 404);
  assert.equal((await b.call("DELETE", `${w}/unanswered/not-an-id`)).status, 404);

  // The activity feed carries a template the dashboard translates.
  const feed = (await b.call("GET", `${w}/activity`)).body;
  const created = feed.find((x) => x.key === "{actor} created {name}");
  assert.equal(created.params.name, "Store Support");
  assert.equal(created.detail_key, "Draft");
  assert.equal(created.text, `${created.params.actor} created Store Support`);
});

test("plan switching is owner-only, simulated, and refuses plans the usage doesn't fit", async () => {
  const { b, ws } = await owner();
  const w = `/w/${ws.id}`;
  await b.call("POST", `${w}/agents`, { name: "One" });
  await b.call("POST", `${w}/agents`, { name: "Two" });
  const starter = await b.call("PATCH", `${w}/plan`, { plan: "starter" });
  assert.equal(starter.status, 409, "Starter allows 1 agent");
  assert.match(starter.body.message, /agents/);
  const business = await b.call("PATCH", `${w}/plan`, { plan: "business" });
  assert.equal(business.status, 200);
  assert.equal(business.body.plan, "business");
  assert.equal(business.body.limits.messages, 50000);
});
