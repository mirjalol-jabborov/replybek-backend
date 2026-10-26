import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, test } from "node:test";

// A fake Polar API on a local port; the real one is never called.
const polarCalls = [];
let checkoutSeq = 0;
const PRODUCTS = { starter: "prod-starter", growth: "prod-growth", business: "prod-business" };
const fakePolar = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const input = body ? JSON.parse(body) : null;
    polarCalls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: input });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url === "/v1/checkouts/") {
      const id = `co_test${++checkoutSeq}`;
      res.statusCode = 201;
      return res.end(JSON.stringify({ id, url: `https://buy.polar.sh/${id}`, metadata: input.metadata }));
    }
    const sub = req.url.match(/^\/v1\/subscriptions\/([^/]+)$/);
    if (req.method === "PATCH" && sub) {
      return res.end(JSON.stringify(subscription({ id: sub[1], ...(input.product_id ? { product_id: input.product_id } : {}), ...(input.cancel_at_period_end ? { cancel_at_period_end: true } : {}) })));
    }
    if (req.method === "POST" && req.url === "/v1/customer-sessions/") {
      res.statusCode = 201;
      return res.end(JSON.stringify({ customer_portal_url: `https://polar.sh/portal?customer=${input.external_customer_id}` }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
});
await new Promise((done) => fakePolar.listen(0, "127.0.0.1", done));

const SECRET = "whsec_" + Buffer.from("polar-test-secret-0123456789").toString("base64");
process.env.POLAR_API_URL = `http://127.0.0.1:${fakePolar.address().port}/v1`;
process.env.POLAR_ACCESS_TOKEN = "test-token";
process.env.POLAR_WEBHOOK_SECRET = SECRET;
process.env.POLAR_PRODUCT_STARTER = PRODUCTS.starter;
process.env.POLAR_PRODUCT_GROWTH = PRODUCTS.growth;
process.env.POLAR_PRODUCT_BUSINESS = PRODUCTS.business;

// Imported after the env is set; `setup.base` is read live because the server starts in before().
const setup = await import("./helpers/setup.js");
const { owner } = setup;
const { signWebhook, verifyWebhook } = await import("../src/lib/polar.js");

after(() => new Promise((done) => fakePolar.close(done)));

let eventSeq = 0;
/** Delivers a webhook to the API the way Polar does. Returns { status, body }. */
async function deliver(type, data, { id = `msg_${++eventSeq}`, secret = SECRET, timestamp } = {}) {
  const raw = JSON.stringify({ type, timestamp: new Date().toISOString(), data });
  const res = await fetch(setup.base + "/billing/polar/webhook", { method: "POST", headers: { "content-type": "application/json", ...signWebhook(raw, { id, secret, timestamp }) }, body: raw });
  return { status: res.status, body: await res.json() };
}
function subscription(over) {
  return { id: "sub_1", status: "active", product_id: PRODUCTS.business, current_period_end: "2026-11-26T00:00:00.000Z", trial_end: null, cancel_at_period_end: false, checkout_id: null, metadata: {}, customer: { external_id: null }, ...over };
}
const lastCheckout = () => polarCalls.filter((c) => c.url === "/v1/checkouts/").at(-1);

test("webhook secrets work in both Polar formats", () => {
  const raw = '{"type":"subscription.updated"}';
  for (const secret of [SECRET, "polar_whs_legacy-secret"]) {
    assert.ok(verifyWebhook(raw, signWebhook(raw, { id: "msg", secret }), secret));
  }
  // A legacy secret is keyed with its own bytes, the way Polar signed before September 2026.
  const ts = String(Math.floor(Date.now() / 1000));
  const legacy = "whsec_legacy-plain-string";
  const sig = crypto.createHmac("sha256", Buffer.from(legacy, "utf8")).update(`msg.${ts}.${raw}`).digest("base64");
  assert.ok(verifyWebhook(raw, { "webhook-id": "msg", "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` }, legacy));
});

test("with Polar configured, plans change through checkout instead of the simulated switch", async () => {
  const { b, ws } = await owner();
  const w = `/w/${ws.id}`;
  const simulated = await b.call("PATCH", `${w}/plan`, { plan: "business" });
  assert.equal(simulated.status, 409);

  const r = await b.call("POST", `${w}/billing/checkout`, { plan: "business" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.url, /^https:\/\/buy\.polar\.sh\/co_test\d+$/);
  const sent = lastCheckout();
  assert.equal(sent.auth, "Bearer test-token");
  assert.deepEqual(sent.body.products, [PRODUCTS.business]);
  assert.equal(sent.body.external_customer_id, ws.id);
  assert.equal(sent.body.metadata.workspace_id, ws.id);
  assert.equal(sent.body.allow_trial, true);
  assert.equal(sent.body.trial_interval_count, 7);
  assert.match(sent.body.success_url, /\?checkout=done#\/settings\/billing$/);

  // Nothing changes until Polar confirms the payment.
  const summary = await b.call("GET", w);
  assert.equal(summary.body.plan, "growth");
  assert.equal(summary.body.billing.provider, "polar");
  assert.equal(summary.body.billing.status, null);
  assert.equal(summary.body.billing.can_manage, false);
  assert.equal((await b.call("POST", `${w}/billing/portal`)).status, 404);
});

test("checkout refuses plans the usage doesn't fit", async () => {
  const { b, ws } = await owner();
  const w = `/w/${ws.id}`;
  await b.call("POST", `${w}/agents`, { name: "One" });
  await b.call("POST", `${w}/agents`, { name: "Two" });
  const r = await b.call("POST", `${w}/billing/checkout`, { plan: "starter" });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /agents/);
});

test("webhooks need a valid, fresh signature", async () => {
  assert.equal((await deliver("subscription.active", subscription(), { secret: "whsec_d3Jvbmc=" })).status, 401);
  assert.equal((await deliver("subscription.active", subscription(), { timestamp: Math.floor(Date.now() / 1000) - 600 })).status, 401);
  const unsigned = await fetch(setup.base + "/billing/polar/webhook", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(unsigned.status, 401);
});

test("a started subscription sets the plan; plan changes switch product in place; only the current subscription counts", async () => {
  const { b, ws } = await owner();
  const w = `/w/${ws.id}`;
  await b.call("POST", `${w}/billing/checkout`, { plan: "business" });
  const checkoutId = `co_test${checkoutSeq}`;

  // An unfinished subscription doesn't touch the workspace.
  await deliver("subscription.created", subscription({ id: "sub_a", status: "incomplete", checkout_id: checkoutId }));
  assert.equal((await b.call("GET", w)).body.billing.status, null);

  const started = subscription({ id: "sub_a", checkout_id: checkoutId, metadata: { workspace_id: ws.id }, customer: { external_id: ws.id } });
  assert.equal((await deliver("subscription.active", started, { id: "msg_act_a" })).status, 200);
  let s = (await b.call("GET", w)).body;
  assert.equal(s.plan, "business");
  assert.equal(s.limits.messages, 50000);
  assert.equal(s.billing.status, "active");
  assert.equal(s.billing.access, "paid");
  assert.equal(s.billing.renews_at, "2026-11-26T00:00:00.000Z");
  assert.equal(s.billing.can_manage, true);
  assert.equal(s.polar_subscription_id, undefined, "raw billing columns stay out of the API");
  const activity = (await b.call("GET", `${w}/activity`)).body;
  assert.ok(activity.some((a) => a.key === "{actor} switched to the {plan} plan" && a.params.plan === "business"));

  // A retried delivery is applied once.
  const again = await deliver("subscription.active", { ...started, product_id: PRODUCTS.starter }, { id: "msg_act_a" });
  assert.equal(again.body.duplicate, true);
  assert.equal((await b.call("GET", w)).body.plan, "business");

  // The customer portal opens for the workspace's Polar customer.
  const portal = await b.call("POST", `${w}/billing/portal`);
  assert.equal(portal.status, 200);
  assert.equal(portal.body.url, `https://polar.sh/portal?customer=${ws.id}`);

  // The owner cancels in the portal: still active until the period ends.
  await deliver("subscription.canceled", { ...started, cancel_at_period_end: true });
  s = (await b.call("GET", w)).body;
  assert.equal(s.billing.status, "active");
  assert.equal(s.billing.cancel_at_period_end, true);
  await deliver("subscription.uncanceled", started);

  // Switching to Growth moves the running subscription to the Growth product; no new checkout.
  const before = polarCalls.length;
  const sw = await b.call("POST", `${w}/billing/checkout`, { plan: "growth" });
  assert.equal(sw.status, 200, JSON.stringify(sw.body));
  assert.equal(sw.body.changed, true);
  const patch = polarCalls.slice(before).find((c) => c.method === "PATCH");
  assert.equal(patch.url, "/v1/subscriptions/sub_a");
  assert.deepEqual(patch.body, { product_id: PRODUCTS.growth });
  assert.ok(!polarCalls.slice(before).some((c) => c.url === "/v1/checkouts/"));
  s = (await b.call("GET", w)).body;
  assert.equal(s.plan, "growth");
  assert.equal((await b.call("POST", `${w}/billing/checkout`, { plan: "growth" })).status, 409);

  // Another subscription that never started is ignored; the current one ending does count.
  await deliver("subscription.revoked", subscription({ id: "sub_other", status: "canceled", metadata: { workspace_id: ws.id } }));
  assert.equal((await b.call("GET", w)).body.billing.status, "active");
  await deliver("subscription.revoked", { ...started, product_id: PRODUCTS.growth, status: "canceled" });
  s = (await b.call("GET", w)).body;
  assert.equal(s.billing.status, "canceled");
  assert.equal(s.billing.access, "ended");

  // After it ended, a new plan is a new checkout, without a second trial.
  await b.call("POST", `${w}/billing/checkout`, { plan: "starter" });
  assert.equal(lastCheckout().body.allow_trial, false);
});

test("a second paying subscription replaces the running one, which stops renewing", async () => {
  const { b, ws } = await owner();
  const w = `/w/${ws.id}`;
  await deliver("subscription.active", subscription({ id: "sub_first", product_id: PRODUCTS.business, customer: { external_id: ws.id } }));
  await deliver("subscription.active", subscription({ id: "sub_second", product_id: PRODUCTS.starter, metadata: { workspace_id: ws.id } }));
  assert.equal((await b.call("GET", w)).body.plan, "starter");
  await new Promise((r) => setTimeout(r, 50)); // the old subscription is cancelled in the background
  const cancel = polarCalls.find((c) => c.method === "PATCH" && c.url === "/v1/subscriptions/sub_first");
  assert.ok(cancel, "old subscription cancelled");
  assert.deepEqual(cancel.body, { cancel_at_period_end: true });
});

test("a subscription for an unknown product or workspace is acknowledged and ignored", async () => {
  const r = await deliver("subscription.active", subscription({ id: "sub_x", product_id: "prod-other", metadata: { workspace_id: "00000000-0000-0000-0000-000000000000" } }));
  assert.equal(r.status, 200);
});

test("the free trial starts only through Polar checkout (card on file); before it, only a few Playground answers", async () => {
  const { b, ws } = await owner();
  const w = `/w/${ws.id}`;
  let s = (await b.call("GET", w)).body;
  assert.equal(s.billing.access, "none");
  assert.equal(s.billing.preview_messages, 3);

  const agent = (await b.call("POST", `${w}/agents`, { name: "Help" })).body;
  await b.call("POST", `${w}/agents/${agent.id}/publish`);
  assert.equal((await b.call("POST", `${w}/agents/${agent.id}/test`, { question: "Hi there" })).status, 200, "Playground works before the trial");

  // A website visitor isn't turned away: without a trial the message goes to the team, not the AI.
  const visit = async () => {
    const v = setup.browser();
    const conv = (await v.call("POST", `/widget/${agent.public_key}/conversations`, {})).body;
    return (await v.call("POST", `/widget/${agent.public_key}/conversations/${conv.conversation_id}/messages`, { text: "Where is my order?" }, { "X-Visitor-Token": conv.visitor_token })).body.messages;
  };
  const blocked = (messages) => messages.some((m) => m.kind === "handoff" && /can't answer right now/.test(m.body));
  const used = (await b.call("GET", w)).body.usage.messages;
  assert.ok(blocked(await visit()), "widget waits for the trial");
  assert.equal((await b.call("GET", w)).body.usage.messages, used, "no AI usage counted");

  // The Playground allowance (3 answers, one used above) runs out; the dashboard shows the trial prompt by its code.
  for (let i = 0; i < 2; i++) assert.equal((await b.call("POST", `${w}/agents/${agent.id}/test`, { question: "Hi there" })).status, 200);
  const out = await b.call("POST", `${w}/agents/${agent.id}/test`, { question: "Hi there" });
  assert.equal(out.status, 402);
  assert.match(out.body.message, /used your 3 free test messages\. Start your 7-day free trial/);
  assert.equal(out.body.code, "trial_required");

  // Starting the trial on Polar (card entered there) turns everything on; onboarding returns to onboarding.
  const checkout = await b.call("POST", `${w}/billing/checkout`, { plan: "growth", return_to: "onboarding" });
  assert.equal(checkout.status, 200);
  assert.match(lastCheckout().body.success_url, /\?checkout=done#\/onboarding$/);
  const trial = subscription({ id: "sub_trial", status: "trialing", product_id: PRODUCTS.growth, checkout_id: `co_test${checkoutSeq}`, trial_end: "2026-11-02T00:00:00.000Z" });
  await deliver("subscription.created", trial);
  s = (await b.call("GET", w)).body;
  assert.equal(s.billing.access, "trial");
  assert.equal(s.billing.status, "trialing");
  assert.equal(s.billing.renews_at, "2026-11-02T00:00:00.000Z");
  assert.equal((await b.call("POST", `${w}/agents/${agent.id}/test`, { question: "Hi there" })).status, 200);
  assert.ok(!blocked(await visit()), "widget answers during the trial");

  // The trial converts to a paid subscription; later it ends and answers stop again.
  await deliver("subscription.active", { ...trial, status: "active" });
  assert.equal((await b.call("GET", w)).body.billing.access, "paid");
  await deliver("subscription.revoked", { ...trial, status: "canceled" });
  assert.equal((await b.call("GET", w)).body.billing.access, "ended");
  const ended = await b.call("POST", `${w}/agents/${agent.id}/test`, { question: "Hi there" });
  assert.equal(ended.status, 402);
  assert.match(ended.body.message, /subscription has ended/);
  assert.equal(ended.body.code, "subscription_ended");
});

test("before the trial a workspace is read-only once onboarding is done; the trial unlocks it", async () => {
  const { b, ws } = await owner();
  const w = `/w/${ws.id}`;
  // Onboarding builds the first agent before the trial.
  const agent = (await b.call("POST", `${w}/agents`, { name: "Help" })).body;
  assert.equal((await b.call("PATCH", `${w}/agents/${agent.id}`, { welcome: "Hello!" })).status, 200);
  assert.equal((await b.call("POST", `${w}/onboarding/complete`, {})).status, 200);

  // After it, nothing can be added or changed...
  for (const [method, path, body] of [
    ["POST", `${w}/agents`, { name: "Second" }],
    ["PATCH", `${w}/agents/${agent.id}`, { welcome: "Changed" }],
    ["POST", `${w}/agents/${agent.id}/sources/qa`, { question: "Hours?", answer: "9 to 6" }],
    ["POST", `${w}/invites`, { email: "new@test.replybek.dev", role: "agent" }],
    ["PATCH", w, { name: "Renamed" }],
    ["DELETE", `${w}/agents/${agent.id}`],
  ]) {
    const r = await b.call(method, path, body);
    assert.equal(r.status, 402, `${method} ${path}`);
    assert.match(r.body.message, /Start your 7-day free trial to make changes/);
    assert.equal(r.body.code, "trial_required");
  }
  // ...but everything can be read, the Playground still answers, and the trial can be started.
  assert.equal((await b.call("GET", `${w}/agents/${agent.id}`)).body.welcome, "Hello!");
  assert.equal((await b.call("POST", `${w}/agents/${agent.id}/test`, { question: "Hi there" })).status, 200);
  assert.equal((await b.call("POST", `${w}/billing/checkout`, { plan: "growth" })).status, 200);

  await deliver("subscription.created", subscription({ id: "sub_unlock", status: "trialing", product_id: PRODUCTS.growth, checkout_id: `co_test${checkoutSeq}` }));
  assert.equal((await b.call("PATCH", `${w}/agents/${agent.id}`, { welcome: "Changed" })).status, 200);
  assert.equal((await b.call("POST", `${w}/agents`, { name: "Second" })).status, 201);
});
