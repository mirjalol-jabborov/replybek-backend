// The guided setup's own record (settings.onboarding): when the setup was finished, when the
// "Get started" list was hidden, and which steps were skipped. What is set up is read from the
// data itself (services, products, ...), so this record is all the server keeps for it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { crmOwner, teammate } from "./helpers/setup.js";

const snap = async (o) => (await o.b.call("GET", `${o.crm}/snapshot?only=settings`)).body;
const put = (o, settings) => o.b.call("PUT", `${o.crm}/settings`, { settings });
const START = { finishedAt: null, dismissedAt: null, skipped: [] };

test("a new workspace starts with an empty setup record, and an admin saves it whole", async () => {
  const o = await crmOwner();
  assert.deepEqual((await snap(o)).settings.onboarding, START);

  const done = await put(o, { onboarding: { finishedAt: "2026-11-18T09:30", dismissedAt: null, skipped: ["store", "services", "team", "store"] } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const saved = { finishedAt: "2026-11-18T09:30", dismissedAt: null, skipped: ["store", "services", "team"] };
  assert.deepEqual(done.body.changes.top.settings.onboarding, saved, "a step skipped twice is kept once");
  assert.deepEqual((await snap(o)).settings.onboarding, saved);

  // Other settings saved later leave it as it is (settings merge one level down).
  assert.equal((await put(o, { slot: 15 })).status, 200);
  assert.deepEqual((await snap(o)).settings.onboarding, saved);

  const hidden = await put(o, { onboarding: { ...saved, dismissedAt: "2026-11-19T10:05" } });
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
  assert.equal((await snap(o)).settings.onboarding.dismissedAt, "2026-11-19T10:05");
});

test("the setup record has a strict shape, and only admins save it", async () => {
  const o = await crmOwner();
  for (const [why, onboarding] of [
    ["half of it", { finishedAt: null }],
    ["an unknown key", { ...START, seen: true }],
    ["a moment that isn't one", { ...START, finishedAt: "2026-11-18" }],
    ["a day the calendar doesn't have", { ...START, dismissedAt: "2026-02-31T10:00" }],
    ["a step the setup doesn't have", { ...START, skipped: ["payments"] }],
    ["the first step, which can't be skipped", { ...START, skipped: ["modules"] }],
    ["skipped as text", { ...START, skipped: "store" }],
    ["not an object", true],
  ]) {
    const r = await put(o, { onboarding });
    assert.equal(r.status, 400, `${why}: ${JSON.stringify(r.body)}`);
  }
  assert.deepEqual((await snap(o)).settings.onboarding, START, "nothing refused was kept");

  const mate = await teammate(o, "agent");
  assert.equal((await put({ ...o, b: mate.b }, { onboarding: { ...START, dismissedAt: "2026-11-18T09:30" } })).status, 403);
});
