// Billing by package: the CRM only, the AI agent only, or both. One subscription per workspace; what
// the workspace may use follows its package. A fake Polar API on a local port; the real one is never called.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const OFFERS = {};
for (const pkg of ["agent", "crm", "both"]) for (const tier of ["starter", "growth"]) OFFERS[`${pkg}_${tier}`] = `prod-${pkg}-${tier}`;

const polarCalls = [];
const polarHolds = new Map(); // what Polar holds for a workspace, whether or not its webhook arrived
const polarProducts = []; // what the setup script made
let seq = 0;
const fakePolar = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const input = body ? JSON.parse(body) : null;
    polarCalls.push({ method: req.method, url: req.url, body: input });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url === "/v1/checkouts/") {
      const id = `co_pkg${++seq}`;
      res.statusCode = 201;
      return res.end(JSON.stringify({ id, url: `https://buy.polar.sh/${id}` }));
    }
    const list = req.url.match(/^\/v1\/subscriptions\/\?external_customer_id=([^&]+)/);
    if (req.method === "GET" && list) return res.end(JSON.stringify({ items: polarHolds.get(decodeURIComponent(list[1])) || [] }));
    const sub = req.url.match(/^\/v1\/subscriptions\/([^/]+)$/);
    if (req.method === "PATCH" && sub) {
      return res.end(JSON.stringify(subscription({ id: sub[1], modified_at: stamp(), ...(input.product_id ? { product_id: input.product_id } : {}), ...(input.cancel_at_period_end ? { cancel_at_period_end: true } : {}) })));
    }
    if (req.method === "GET" && req.url.startsWith("/v1/products/")) return res.end(JSON.stringify({ items: polarProducts }));
    if (req.method === "POST" && req.url === "/v1/customer-sessions/") return res.end(JSON.stringify({ customer_portal_url: "https://polar.sh/portal/pkg" }));
    if (req.method === "POST" && req.url === "/v1/products/") {
      const made = { id: `prod-made-${polarProducts.length + 1}`, ...input };
      polarProducts.push(made);
      res.statusCode = 201;
      return res.end(JSON.stringify(made));
    }
    res.statusCode = 404;
    res.end("{}");
  });
});
await new Promise((done) => fakePolar.listen(0, "127.0.0.1", done));

const SECRET = "whsec_" + Buffer.from("polar-packages-secret-0123456789").toString("base64");
process.env.POLAR_API_URL = `http://127.0.0.1:${fakePolar.address().port}/v1`;
process.env.POLAR_ACCESS_TOKEN = "test-token";
process.env.POLAR_WEBHOOK_SECRET = SECRET;
for (const [offer, id] of Object.entries(OFFERS)) process.env[`POLAR_PRODUCT_${offer.toUpperCase()}`] = id;
process.env.POLAR_PRICE_CRM_GROWTH = "1900";
process.env.TRIAL_DAYS_CRM = "14";

const setup = await import("./helpers/setup.js");
const { owner, crmOwner, teammate, query } = setup;
const { signWebhook } = await import("../src/core/billing/polar.js");
const { addProductOrBuy } = await import("../src/core/billing/billing.js");
const { productAccess } = await import("../src/core/billing/product-access.js");

after(() => new Promise((done) => fakePolar.close(done)));
// The switch: off unless a test turns the CRM's billing on.
beforeEach(() => delete process.env.CRM_BILLING);
const crmBilled = () => (process.env.CRM_BILLING = "on");

let clock = Date.parse("2026-11-18T08:00:00.000Z");
/** A moment later than every one before it, the way Polar stamps a change (microseconds). */
const stamp = () => new Date((clock += 1000)).toISOString().replace("Z", "123Z");
let eventSeq = 0;
async function deliver(type, data, id = `msg_pkg_${++eventSeq}`) {
  const raw = JSON.stringify({ type, timestamp: new Date().toISOString(), data });
  const res = await fetch(setup.base + "/billing/polar/webhook", { method: "POST", headers: { "content-type": "application/json", ...signWebhook(raw, { id, secret: SECRET }) }, body: raw });
  return { status: res.status, body: await res.json() };
}
function subscription(over) {
  return { id: "sub_pkg", status: "active", product_id: OFFERS.crm_growth, current_period_end: "2026-12-18T00:00:00.000Z", trial_end: null, cancel_at_period_end: false, checkout_id: null, metadata: {}, customer: { external_id: null }, ...over };
}
const lastCheckout = () => polarCalls.filter((c) => c.url === "/v1/checkouts/").at(-1);
const billing = async (o) => (await o.b.call("GET", `/w/${o.ws.id}/billing/packages`)).body;
const products = async (o) => (await query("SELECT products FROM workspaces WHERE id = $1", [o.ws.id])).rows[0].products;
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const addCustomer = (o, name = "Dilnoza Rahimova") => o.b.call("POST", `/w/${o.ws.id}/crm/customers`, { name });

test("with the CRM's switch off the CRM is free and open, and products are added as before", async () => {
  const o = await crmOwner();
  const w = `/w/${o.ws.id}`;
  assert.equal((await addCustomer(o)).status, 201);
  const b = await billing(o);
  assert.deepEqual(b.products.crm, { on: true, access: null, next: null, offer: null });
  assert.deepEqual(b.products.agent, { on: false, access: null, next: "start_trial", offer: { package: "agent", tier: "growth", trial_days: 7 } });
  assert.deepEqual(b.packages.map((p) => [p.key, p.sold]), [["agent", true], ["crm", false], ["both", false]]);
  // A package with a product that is free isn't sold.
  const refused = await o.b.call("POST", `${w}/billing/checkout`, { package: "crm", tier: "growth" });
  assert.deepEqual([refused.status, refused.body.code, refused.body.product], [409, "product_free", "crm"]);
  assert.deepEqual((await o.b.call("POST", `${w}/products`, { add: "agent" })).body, { products: ["crm", "agent"] });

  // The AI agent's package going live keeps the free CRM.
  await deliver("subscription.active", subscription({ id: "sub_free_crm", product_id: OFFERS.agent_growth, customer: { external_id: o.ws.id }, created_at: stamp() }));
  assert.deepEqual(await products(o), ["crm", "agent"]);
  assert.equal((await addCustomer(o, "Bobur Aliyev")).status, 201);
  assert.equal((await billing(o)).products.agent.access, "paid");
});

test("the catalogue reads prices and Polar ids from configuration", async () => {
  crmBilled();
  const o = await crmOwner();
  const { packages } = await billing(o);
  const crm = packages.find((p) => p.key === "crm");
  assert.deepEqual(crm.products, ["crm"]);
  assert.equal(crm.sold, true);
  assert.deepEqual(crm.tiers, [
    { tier: "starter", price: null, ready: true },
    { tier: "growth", price: { amount: 1900, currency: "usd" }, ready: true },
    { tier: "business", price: null, ready: false },
  ]);
  assert.deepEqual(packages.find((p) => p.key === "both").products, ["agent", "crm"]);
  const r = await o.b.call("POST", `/w/${o.ws.id}/billing/checkout`, { package: "crm", tier: "business" });
  assert.deepEqual([r.status, r.body.code], [503, "offer_not_ready"]);
  const bad = await o.b.call("POST", `/w/${o.ws.id}/billing/checkout`, { package: "crm" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.issues[0].params.code, "tier_required");
});

test("with the switch on the CRM reads always work, writes need its trial, and only the owner buys", async () => {
  crmBilled();
  const o = await crmOwner();
  const w = `/w/${o.ws.id}`;
  const admin = await teammate(o, "admin"); // the team's routes stay open: they aren't the CRM's
  const member = await teammate(o, "agent", "Malika Tosheva");

  assert.equal((await o.b.call("GET", `${w}/crm/snapshot`)).status, 200);
  const locked = await addCustomer(o);
  assert.equal(locked.status, 402);
  assert.deepEqual({ ...locked.body, message: undefined }, { message: undefined, code: "trial_required", reason: "read_only", product: "crm", offer: { package: "crm", tier: "growth", trial_days: 14 } });
  assert.equal((await member.b.call("POST", `${w}/crm/customers`, { name: "Aziz" })).status, 402);
  assert.equal((await admin.b.call("PUT", `${w}/crm/settings`, { settings: { slot: 15 } })).status, 402);
  // A check that saves nothing stays open.
  assert.notEqual((await o.b.call("POST", `${w}/crm/booking/check`, {})).status, 402);
  assert.deepEqual((await billing(o)).products.crm, { on: true, access: "none", next: "start_trial", offer: { package: "crm", tier: "growth", trial_days: 14 } });

  // Only the owner buys.
  for (const who of [admin, member]) assert.equal((await who.b.call("POST", `${w}/billing/checkout`, { package: "crm", tier: "growth" })).status, 403);
  assert.equal((await admin.b.call("GET", `${w}/billing/packages`)).status, 200);
  assert.equal((await o.b.call("POST", `${w}/billing/checkout`, { package: "crm", tier: "growth", origin: "https://elsewhere.example" })).status, 400);

  const r = await o.b.call("POST", `${w}/billing/checkout`, { package: "crm", tier: "growth", origin: "http://localhost:5192" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const sent = lastCheckout().body;
  assert.deepEqual(sent.products, [OFFERS.crm_growth]);
  assert.deepEqual(sent.metadata, { workspace_id: o.ws.id, plan: "growth", package: "crm" });
  assert.equal(sent.allow_trial, true);
  assert.equal(sent.trial_interval_count, 14);
  assert.equal(sent.success_url, "http://localhost:5192/?checkout=done#/");

  // Nothing changes until Polar confirms; then the trial opens the CRM.
  assert.equal((await addCustomer(o)).status, 402);
  const trial = subscription({ id: "sub_crm_trial", status: "trialing", product_id: OFFERS.crm_growth, checkout_id: r.body.url.split("/").at(-1), trial_end: "2026-12-02T00:00:00.000Z", created_at: stamp() });
  await deliver("subscription.created", trial);
  assert.equal((await addCustomer(o)).status, 201);
  assert.equal((await member.b.call("POST", `${w}/crm/customers`, { name: "Aziz" })).status, 201);
  assert.deepEqual((await billing(o)).products.crm, { on: true, access: "trial", next: null, offer: null });
  assert.deepEqual(await products(o), ["crm"]);

  await deliver("subscription.active", { ...trial, status: "active", modified_at: stamp() });
  assert.equal((await billing(o)).products.crm.access, "paid");

  // Ended: read-only again, and the trial isn't given twice.
  await deliver("subscription.revoked", { ...trial, status: "canceled", modified_at: stamp() });
  const ended = await addCustomer(o, "Late");
  assert.deepEqual([ended.status, ended.body.code, ended.body.product], [402, "subscription_ended", "crm"]);
  assert.equal((await o.b.call("GET", `${w}/crm/snapshot`)).body.customers.length, 2, "reads still work");
  assert.deepEqual((await billing(o)).products.crm, { on: true, access: "ended", next: "buy", offer: { package: "crm", tier: "growth", trial_days: 0 } });
  await o.b.call("POST", `${w}/billing/checkout`, { package: "crm", tier: "growth" });
  assert.equal(lastCheckout().body.allow_trial, false);
});

test("a failed CRM renewal keeps it working through the grace period, then asks for the card", async () => {
  crmBilled();
  const o = await crmOwner();
  const sub = subscription({ id: "sub_crm_due", customer: { external_id: o.ws.id }, created_at: stamp() });
  await deliver("subscription.active", sub);
  await deliver("subscription.past_due", { ...sub, status: "past_due", modified_at: stamp() });
  assert.equal((await addCustomer(o)).status, 201);
  assert.equal((await billing(o)).products.crm.next, "update_card");
  await query("UPDATE workspaces SET past_due_since = now() - interval '3 days 1 minute' WHERE id = $1", [o.ws.id]);
  const r = await addCustomer(o, "Overdue");
  assert.deepEqual([r.status, r.body.code, r.body.overdue], [402, "subscription_ended", true]);
  assert.deepEqual((await billing(o)).products.crm, { on: true, access: "ended", next: "update_card", offer: null });
});

test("from the AI agent to both and back down: one subscription changes package, and the CRM's data waits while it is off", async () => {
  crmBilled();
  const o = await owner();
  const w = `/w/${o.ws.id}`;
  await deliver("subscription.active", subscription({ id: "sub_up", product_id: OFFERS.agent_growth, customer: { external_id: o.ws.id }, created_at: stamp() }));
  let b = await billing(o);
  assert.equal(b.products.agent.access, "paid");
  // A running subscription changes package in place: no trial.
  assert.deepEqual(b.products.crm, { on: false, access: null, next: "buy", offer: { package: "both", tier: "growth", trial_days: 0 } });
  assert.equal((await o.b.call("GET", `${w}/crm/snapshot`)).body.code, "product_off");

  // Up: the running subscription moves to the package with both; no second checkout.
  const before = polarCalls.length;
  const up = await o.b.call("POST", `${w}/billing/checkout`, { package: "both", tier: "growth" });
  assert.deepEqual(up.body, { changed: true });
  assert.deepEqual(polarCalls.slice(before).map((c) => [c.method, c.url, c.body]), [["PATCH", "/v1/subscriptions/sub_up", { product_id: OFFERS.both_growth }]]);
  assert.deepEqual(await products(o), ["agent", "crm"]);
  assert.equal((await addCustomer(o)).status, 201);
  assert.equal((await o.b.call("POST", `${w}/billing/checkout`, { package: "both", tier: "growth" })).body.code, "already_on");

  // Down to the AI agent: the CRM is off, its data stays.
  assert.deepEqual((await o.b.call("POST", `${w}/billing/checkout`, { package: "agent", tier: "growth" })).body, { changed: true });
  assert.deepEqual(await products(o), ["agent"]);
  const off = await o.b.call("GET", `${w}/crm/snapshot`);
  assert.deepEqual([off.status, off.body.code, off.body.product], [404, "product_off", "crm"]);
  assert.equal((await addCustomer(o, "Not now")).status, 404);
  assert.equal((await query("SELECT count(*)::int AS n FROM crm_customers WHERE workspace_id = $1", [o.ws.id])).rows[0].n, 1);
  assert.equal((await o.b.call("GET", `${w}/agents`)).status, 200);

  // Back up: everything is where it was.
  await o.b.call("POST", `${w}/billing/checkout`, { package: "both", tier: "growth" });
  assert.deepEqual((await o.b.call("GET", `${w}/crm/snapshot`)).body.customers.map((c) => c.name), ["Dilnoza Rahimova"]);

  // Down to the CRM: the AI agent's routes are off, its agents stay.
  const agent = (await o.b.call("POST", `${w}/agents`, { name: "Help" })).body;
  await o.b.call("POST", `${w}/billing/checkout`, { package: "crm", tier: "growth" });
  assert.deepEqual(await products(o), ["crm"]);
  assert.equal((await o.b.call("GET", `${w}/agents`)).body.code, "product_off");
  assert.equal((await addCustomer(o, "Still here")).status, 201);
  await o.b.call("POST", `${w}/billing/checkout`, { package: "both", tier: "growth" });
  assert.equal((await o.b.call("GET", `${w}/agents/${agent.id}`)).body.name, "Help");
});

test("adding a product while the CRM is billed buys the package that gives it", async () => {
  crmBilled();
  const row = async (o) => (await query("SELECT * FROM workspaces WHERE id = $1", [o.ws.id])).rows[0];
  // No subscription yet: a checkout for the CRM's package.
  const fresh = await crmOwner();
  const out = await addProductOrBuy(await row(fresh), "agent", fresh.user);
  assert.deepEqual(out.products, ["crm"]);
  assert.match(out.url, /^https:\/\/buy\.polar\.sh\/co_pkg\d+$/);
  assert.deepEqual(lastCheckout().body.products, [OFFERS.both_growth]);
  assert.equal(lastCheckout().body.trial_interval_count, 14);

  // A running subscription: its package changes in place.
  const paying = await crmOwner();
  await deliver("subscription.active", subscription({ id: "sub_add", product_id: OFFERS.crm_starter, customer: { external_id: paying.ws.id }, created_at: stamp() }));
  assert.deepEqual(await addProductOrBuy(await row(paying), "agent", paying.user), { products: ["crm", "agent"], changed: true });
  assert.equal((await query("SELECT plan, billing_package FROM workspaces WHERE id = $1", [paying.ws.id])).rows[0].billing_package, "both");
  // What it already has changes nothing.
  assert.deepEqual(await addProductOrBuy(await row(paying), "crm", paying.user), { products: ["crm", "agent"] });

  // With the switch off it is added for free, as before.
  delete process.env.CRM_BILLING;
  const local = await owner();
  assert.deepEqual(await addProductOrBuy(await row(local), "crm", local.user), { products: ["agent", "crm"] });
});

test("a repeated or late event never undoes a newer state", async () => {
  crmBilled();
  const o = await crmOwner();
  const both = subscription({ id: "sub_order", product_id: OFFERS.both_growth, customer: { external_id: o.ws.id }, created_at: stamp() });
  const older = { ...both, product_id: OFFERS.crm_growth, modified_at: stamp() };
  const newer = { ...both, modified_at: stamp() };
  await deliver("subscription.updated", newer);
  assert.deepEqual(await products(o), ["crm", "agent"]);

  // The same state again (another delivery id, so not caught as a duplicate) writes the same row.
  const snapshotRow = async () => (await query("SELECT plan, billing_package, products, subscription_status, subscription_modified_at FROM workspaces WHERE id = $1", [o.ws.id])).rows[0];
  const now = await snapshotRow();
  await deliver("subscription.updated", newer);
  assert.deepEqual(await snapshotRow(), now);
  // An older picture of the same subscription arriving late is ignored.
  await deliver("subscription.updated", older);
  assert.deepEqual(await snapshotRow(), now);

  // A subscription started before the running one can't take over, nor stop the running one.
  const before = polarCalls.length;
  await deliver("subscription.active", subscription({ id: "sub_order_old", product_id: OFFERS.crm_starter, customer: { external_id: o.ws.id }, created_at: "2026-01-01T00:00:00.000Z" }));
  assert.deepEqual(await snapshotRow(), now);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!polarCalls.slice(before).some((c) => c.method === "PATCH"), "nothing cancelled");

  // A newer picture counts; sync then finds the same state and changes nothing.
  await deliver("subscription.canceled", { ...both, status: "canceled", modified_at: stamp() });
  assert.equal((await snapshotRow()).subscription_status, "canceled");
  assert.deepEqual(await products(o), ["crm", "agent"], "an ended package keeps its products, read-only");
  polarHolds.set(o.ws.id, [older]);
  assert.equal((await o.b.call("POST", `/w/${o.ws.id}/billing/sync`)).body.changed, false);
  assert.equal((await snapshotRow()).subscription_status, "canceled");
});

test("sync picks up a package whose webhook never arrived and sets the products", async () => {
  crmBilled();
  const o = await crmOwner();
  polarHolds.set(o.ws.id, [subscription({ id: "sub_lost_pkg", status: "trialing", product_id: OFFERS.both_starter, customer: { external_id: o.ws.id }, created_at: stamp() })]);
  const r = await o.b.call("POST", `/w/${o.ws.id}/billing/sync`);
  assert.deepEqual(r.body, { changed: true, status: "trialing", plan: "starter", package: "both", products: ["crm", "agent"] });
  assert.equal((await addCustomer(o)).status, 201);
  assert.equal((await o.b.call("POST", `/w/${o.ws.id}/billing/sync`)).body.changed, false);
});

test("the setup script makes one Polar product per priced offer and writes the ids", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replybek-polar-setup-"));
  const out = path.join(dir, "polar.env");
  fs.writeFileSync(out, "POLAR_ACCESS_TOKEN=test-token\nPOLAR_PRICE_CRM_GROWTH=1900\nPOLAR_PRICE_BOTH_GROWTH=4900\nPOLAR_PRICE_AGENT_STARTER=1900\n");
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "../scripts/polar-setup.js");
  const run = () => promisify(execFile)(process.execPath, [script, "--api", process.env.POLAR_API_URL, "--skip-webhook", "--out", out], { env: { PATH: process.env.PATH } });
  await run();
  const made = (name) => polarProducts.find((p) => p.name === name);
  assert.deepEqual(made("Replybek CRM Growth").prices, [{ amount_type: "fixed", price_amount: 1900, price_currency: "usd" }]);
  assert.equal(made("Replybek AI agent + CRM Growth").prices[0].price_amount, 4900);
  const written = fs.readFileSync(out, "utf8");
  assert.match(written, new RegExp(`^POLAR_PRODUCT_CRM_GROWTH=${made("Replybek CRM Growth").id}$`, "m"));
  assert.match(written, new RegExp(`^POLAR_PRODUCT_BOTH_GROWTH=${made("Replybek AI agent + CRM Growth").id}$`, "m"));
  assert.match(written, /^POLAR_PRODUCT_AGENT_STARTER=prod-made-\d+$/m);
  assert.doesNotMatch(written, /POLAR_PRODUCT_CRM_STARTER/, "an offer without a price isn't made");
  // Again: nothing new is made.
  const count = polarProducts.length;
  await run();
  assert.equal(polarProducts.length, count);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a product's trial is given once: a package with a product already tried starts without a trial", async () => {
  crmBilled();
  // The AI agent was tried and the trial ended: buying "both" must not open a second AI agent trial.
  const o = await owner();
  const w = `/w/${o.ws.id}`;
  const tried = subscription({ id: "sub_tried_agent", status: "trialing", product_id: OFFERS.agent_growth, customer: { external_id: o.ws.id }, trial_end: "2026-11-25T00:00:00.000Z", created_at: stamp() });
  await deliver("subscription.created", tried);
  await deliver("subscription.canceled", { ...tried, status: "canceled", modified_at: stamp() });
  await o.b.call("POST", `${w}/billing/checkout`, { package: "both", tier: "growth" });
  assert.equal(lastCheckout().body.allow_trial, false);
  assert.deepEqual((await billing(o)).products.crm, { on: false, access: null, next: "buy", offer: { package: "both", tier: "growth", trial_days: 0 } });

  // The same the other way: the CRM was tried, so adding the AI agent is bought without a trial.
  const c = await crmOwner();
  const crmTrial = subscription({ id: "sub_tried_crm", status: "trialing", product_id: OFFERS.crm_growth, customer: { external_id: c.ws.id }, trial_end: "2026-12-02T00:00:00.000Z", created_at: stamp() });
  await deliver("subscription.created", crmTrial);
  await deliver("subscription.revoked", { ...crmTrial, status: "canceled", modified_at: stamp() });
  const locked = await addCustomer(c);
  assert.deepEqual([locked.status, locked.body.code], [402, "subscription_ended"]);
  assert.deepEqual((await billing(c)).products.agent.offer, { package: "both", tier: "growth", trial_days: 0 });

  // Nothing tried yet: the package's trial, as before.
  const fresh = await crmOwner();
  await fresh.b.call("POST", `/w/${fresh.ws.id}/billing/checkout`, { package: "both", tier: "growth" });
  assert.equal(lastCheckout().body.trial_interval_count, 14);
});

test("a package only takes away the products the package before it gave", async () => {
  // Signed up for the CRM while it was free, then paid for the AI agent.
  const o = await crmOwner();
  const w = `/w/${o.ws.id}`;
  assert.equal((await addCustomer(o)).status, 201);
  await o.b.call("POST", `${w}/products`, { add: "agent" });
  const sub = subscription({ id: "sub_kept_crm", product_id: OFFERS.agent_growth, customer: { external_id: o.ws.id }, created_at: stamp() });
  await deliver("subscription.active", sub);
  // The CRM's billing is turned on: a renewal of the same package keeps the CRM on, read-only.
  crmBilled();
  await deliver("subscription.updated", { ...sub, current_period_end: "2027-01-18T00:00:00.000Z", modified_at: stamp() });
  assert.deepEqual(await products(o), ["crm", "agent"]);
  assert.equal((await o.b.call("GET", `${w}/crm/snapshot`)).body.customers.length, 1);
  const locked = await addCustomer(o, "Bobur Aliyev");
  assert.deepEqual([locked.status, locked.body.reason, locked.body.offer.package], [402, "read_only", "both"]);
  // Up to both and back down: now the package before gave the CRM, so it goes, and its data waits.
  await o.b.call("POST", `${w}/billing/checkout`, { package: "both", tier: "growth" });
  assert.equal((await addCustomer(o, "Bobur Aliyev")).status, 201);
  await o.b.call("POST", `${w}/billing/checkout`, { package: "agent", tier: "growth" });
  assert.deepEqual(await products(o), ["agent"]);
  assert.equal((await query("SELECT count(*)::int AS n FROM crm_customers WHERE workspace_id = $1", [o.ws.id])).rows[0].n, 2);

  // A workspace with no subscription before keeps what it had: buying the CRM leaves its AI agent on.
  delete process.env.CRM_BILLING;
  const a = await owner();
  await a.b.call("POST", `/w/${a.ws.id}/products`, { add: "crm" });
  crmBilled();
  await deliver("subscription.active", subscription({ id: "sub_crm_first", product_id: OFFERS.crm_growth, customer: { external_id: a.ws.id }, created_at: stamp() }));
  assert.deepEqual(await products(a), ["agent", "crm"]);
  assert.equal((await billing(a)).products.agent.access, "none");
});

test("a subscription from before packages can't be taken over by an older one", async () => {
  const o = await owner();
  await deliver("subscription.active", subscription({ id: "sub_legacy_new", product_id: OFFERS.agent_growth, customer: { external_id: o.ws.id }, created_at: "2026-10-01T00:00:00.000000Z" }));
  // As 80-packages.sql leaves a workspace that subscribed before packages.
  await query("UPDATE workspaces SET subscription_created_at = NULL, subscription_modified_at = NULL, billing_package = NULL WHERE id = $1", [o.ws.id]);
  const before = polarCalls.length;
  await deliver("subscription.updated", subscription({ id: "sub_legacy_old", product_id: OFFERS.agent_starter, customer: { external_id: o.ws.id }, created_at: "2026-01-01T00:00:00.000000Z" }));
  await new Promise((r) => setTimeout(r, 50));
  const row = async () => (await query("SELECT plan, polar_subscription_id, subscription_created_at FROM workspaces WHERE id = $1", [o.ws.id])).rows[0];
  assert.deepEqual(await row(), { plan: "growth", polar_subscription_id: "sub_legacy_new", subscription_created_at: null });
  assert.ok(!polarCalls.slice(before).some((c) => c.method === "PATCH"), "nothing cancelled");
  // Its own next event still applies, and stamps it.
  await deliver("subscription.updated", subscription({ id: "sub_legacy_new", product_id: OFFERS.agent_growth, customer: { external_id: o.ws.id }, created_at: "2026-10-01T00:00:00.000000Z", modified_at: stamp() }));
  assert.equal((await row()).subscription_created_at.toISOString(), "2026-10-01T00:00:00.000Z");
});

test("the AI agent may answer only while the workspace has it and its package gives it", async () => {
  crmBilled();
  const o = await owner();
  const w = `/w/${o.ws.id}`;
  const row = async () => (await query("SELECT * FROM workspaces WHERE id = $1", [o.ws.id])).rows[0];
  await deliver("subscription.active", subscription({ id: "sub_answers", product_id: OFFERS.both_growth, customer: { external_id: o.ws.id }, created_at: stamp() }));
  assert.equal(productAccess(await row(), "agent"), "paid");
  await o.b.call("POST", `${w}/billing/checkout`, { package: "crm", tier: "growth" });
  assert.equal(productAccess(await row(), "agent"), "none");
  assert.equal(productAccess(await row(), "crm"), "paid");
  // The package gives it but the workspace doesn't have it: no answers either.
  assert.equal(productAccess({ ...(await row()), billing_package: "both", products: ["crm"] }, "agent"), "none");
  // Without Polar nothing is billed, as before.
  const token = process.env.POLAR_ACCESS_TOKEN;
  delete process.env.POLAR_ACCESS_TOKEN;
  try {
    assert.equal(productAccess(await row(), "agent"), null);
  } finally {
    process.env.POLAR_ACCESS_TOKEN = token;
  }
});


test("POST /products buys the package once the CRM is billed, and the summary shows each product", async () => {
  // Switch off: added for free, as before; the summary says so.
  const local = await owner();
  assert.deepEqual((await local.b.call("POST", `/w/${local.ws.id}/products`, { add: "crm" })).body, { products: ["agent", "crm"] });
  let s = (await local.b.call("GET", `/w/${local.ws.id}`)).body;
  assert.deepEqual(s.billing.products.crm, { on: true, access: null, next: null, offer: null });
  assert.equal(s.billing.package, null);
  for (const raw of ["billing_package", "trial_products", "subscription_created_at", "subscription_modified_at"]) assert.equal(s[raw], undefined, raw);

  crmBilled();
  const o = await crmOwner();
  const w = `/w/${o.ws.id}`;
  const admin = await teammate(o, "admin");
  assert.equal((await admin.b.call("POST", `${w}/products`, { add: "agent" })).status, 403);
  const r = await o.b.call("POST", `${w}/products`, { add: "agent" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.products, ["crm"]);
  assert.match(r.body.url, /^https:\/\/buy\.polar\.sh\//);
  assert.deepEqual(lastCheckout().body.products, [OFFERS.both_growth]);
  s = (await o.b.call("GET", w)).body;
  assert.deepEqual(s.billing.products.agent, { on: false, access: null, next: "start_trial", offer: { package: "both", tier: "growth", trial_days: 14 } });
  assert.deepEqual(s.billing.products.crm, { on: true, access: "none", next: "start_trial", offer: { package: "crm", tier: "growth", trial_days: 14 } });

  await deliver("subscription.created", subscription({ id: "sub_wired", status: "trialing", product_id: OFFERS.both_growth, checkout_id: r.body.url.split("/").at(-1), created_at: stamp() }));
  s = (await o.b.call("GET", w)).body;
  assert.deepEqual(s.products, ["crm", "agent"]);
  assert.equal(s.billing.package, "both");
  assert.equal(s.billing.products.agent.access, "trial");
  assert.equal(s.billing.products.crm.access, "trial");
});

/** A visitor's message on an agent's widget; returns the AI messages counted this month before and after. */
async function visitorAsks(o, agent) {
  const used = async () => (await o.b.call("GET", `/w/${o.ws.id}`)).body.usage.messages;
  const before = await used();
  const v = setup.browser();
  const conv = (await v.call("POST", `/widget/${agent.public_key}/conversations`, {})).body;
  await v.call("POST", `/widget/${agent.public_key}/conversations/${conv.conversation_id}/messages`, { text: "Where is my order?" }, { "X-Visitor-Token": conv.visitor_token });
  return [before, await used()];
}

test("the AI agent stops answering once the package no longer gives it, and starts again when it does", async () => {
  crmBilled();
  const o = await owner();
  const w = `/w/${o.ws.id}`;
  await deliver("subscription.active", subscription({ id: "sub_wired_answers", product_id: OFFERS.both_growth, customer: { external_id: o.ws.id }, created_at: stamp() }));
  const agent = (await o.b.call("POST", `${w}/agents`, { name: "Help" })).body;
  await o.b.call("POST", `${w}/agents/${agent.id}/publish`);
  let [before, now] = await visitorAsks(o, agent);
  assert.equal(now, before + 1, "answers while the package gives it");
  await o.b.call("POST", `${w}/billing/checkout`, { package: "crm", tier: "growth" });
  [before, now] = await visitorAsks(o, agent);
  assert.equal(now, before, "no AI answer, no AI message counted");
  await o.b.call("POST", `${w}/billing/checkout`, { package: "both", tier: "growth" });
  [before, now] = await visitorAsks(o, agent);
  assert.equal(now, before + 1);
});

test("a paid CRM alone never gives the AI agent: added through POST /products it is bought, not free", async () => {
  crmBilled();
  const o = await crmOwner();
  const w = `/w/${o.ws.id}`;
  await deliver("subscription.active", subscription({ id: "sub_wired_crm", product_id: OFFERS.crm_growth, customer: { external_id: o.ws.id }, created_at: stamp() }));
  // A product in the list that the package doesn't give (as one added before the wiring was) can't answer.
  await query("UPDATE workspaces SET products = '{crm,agent}' WHERE id = $1", [o.ws.id]);
  const agent = (await o.b.call("POST", `${w}/agents`, { name: "Free help" })).body;
  await o.b.call("POST", `${w}/agents/${agent.id}/publish`);
  const tests = [];
  for (let i = 0; i < 5; i++) tests.push((await o.b.call("POST", `${w}/agents/${agent.id}/test`, { question: "Hi" })).status);
  assert.deepEqual(tests, [200, 200, 200, 402, 402], "only the Playground's preview answers");
  const [before, now] = await visitorAsks(o, agent);
  assert.equal(now, before);
  // POST /products changes the running subscription to the package with both.
  await query("UPDATE workspaces SET products = '{crm}' WHERE id = $1", [o.ws.id]);
  assert.deepEqual((await o.b.call("POST", `${w}/products`, { add: "agent" })).body, { products: ["crm", "agent"], changed: true });
  assert.equal((await query("SELECT billing_package FROM workspaces WHERE id = $1", [o.ws.id])).rows[0].billing_package, "both");
});

test("checkout, the portal and POST /products come back to the app that asked, never to another address", async () => {
  crmBilled();
  const o = await crmOwner();
  const w = `/w/${o.ws.id}`;
  const CRM_APP = "http://localhost:5192";
  ok(await o.b.call("POST", `${w}/billing/checkout`, { package: "crm", tier: "growth", origin: CRM_APP }));
  assert.deepEqual([lastCheckout().body.success_url, lastCheckout().body.return_url], [`${CRM_APP}/?checkout=done#/`, `${CRM_APP}/#/`]);
  const bad = await o.b.call("POST", `${w}/billing/checkout`, { package: "crm", tier: "growth", origin: "https://evil.example" });
  assert.deepEqual([bad.status, bad.body.code], [400, "bad_origin"]);
  // Adding the AI agent from the CRM: its checkout comes back to the CRM too.
  const added = ok(await o.b.call("POST", `${w}/products`, { add: "agent", origin: CRM_APP }));
  assert.match(added.url, /^https:\/\/buy\.polar\.sh\//);
  assert.equal(lastCheckout().body.success_url, `${CRM_APP}/?checkout=done#/`);
  assert.deepEqual(lastCheckout().body.products, [OFFERS.both_growth]);
  const strange = await o.b.call("POST", `${w}/products`, { add: "agent", origin: "https://evil.example" });
  assert.deepEqual([strange.status, strange.body.code], [400, "bad_origin"]);
  // The portal, once there is a subscription.
  await deliver("subscription.active", subscription({ id: "sub_back", customer: { external_id: o.ws.id }, created_at: stamp() }));
  assert.equal(ok(await o.b.call("POST", `${w}/billing/portal`, { origin: CRM_APP })).url, "https://polar.sh/portal/pkg");
  assert.equal(polarCalls.filter((c) => c.url === "/v1/customer-sessions/").at(-1).body.return_url, `${CRM_APP}/#/`);
});

test("the packages answer says how often an offer is paid, and what the running subscription costs, from Polar's own data", async () => {
  crmBilled();
  const o = await crmOwner();
  const { packages, subscription: none } = await billing(o);
  assert.deepEqual(packages.map((p) => [p.key, p.interval]), [["agent", "month"], ["crm", "month"], ["both", "month"]]);
  assert.equal(none, null, "no subscription yet");
  // On trial: Polar's subscription carries its amount, currency, interval and the trial's end.
  const trial = subscription({ id: "sub_terms", status: "trialing", amount: 1900, currency: "USD", recurring_interval: "month", trial_end: "2026-12-02T00:00:00.000Z", customer: { external_id: o.ws.id }, created_at: stamp() });
  await deliver("subscription.created", trial);
  assert.deepEqual((await billing(o)).subscription, { status: "trialing", interval: "month", amount: 1900, currency: "usd", trial_ends_at: "2026-12-02T00:00:00.000Z" });
  // Paying: no trial end. A picture without those numbers (as stored before they were kept) says null, never a guess.
  await deliver("subscription.active", { ...trial, status: "active", trial_end: null, modified_at: stamp() });
  assert.deepEqual((await billing(o)).subscription, { status: "active", interval: "month", amount: 1900, currency: "usd", trial_ends_at: null });
  const { amount, currency, recurring_interval, ...bare } = trial;
  await deliver("subscription.updated", { ...bare, status: "active", trial_end: null, modified_at: stamp() });
  assert.deepEqual((await billing(o)).subscription, { status: "active", interval: null, amount: null, currency: null, trial_ends_at: null });
  // The workspace summary keeps the raw columns to itself.
  const summary = (await o.b.call("GET", `/w/${o.ws.id}`)).body;
  for (const key of ["subscription_amount", "subscription_currency", "subscription_interval", "subscription_trial_end"]) assert.equal(key in summary, false, key);
  // Ended: no running subscription to describe.
  await deliver("subscription.revoked", { ...bare, status: "canceled", trial_end: null, modified_at: stamp() });
  assert.equal((await billing(o)).subscription, null);
});

test("the business's public pages: while its billed CRM is unpaid customers can look but not book, cancel or order", async () => {
  const { browser } = setup;
  const { addDays, dayOf, nowIn } = await import("../src/crm/shared/time.js");
  const day = addDays(dayOf(nowIn("Asia/Tashkent", new Date())), 2);
  const o = await crmOwner();
  const crm = `/w/${o.ws.id}/crm`;
  const post = async (path, body) => (await o.b.call("POST", crm + path, body)).body;
  const slug = `unpaid-${process.pid}`;
  const page = { slug, booking: true, shop: true, description: "", phone: "", address: "", languages: ["uz"], paymentMethods: ["cash"], deliveryMethods: ["pickup"] };
  assert.equal((await o.b.call("PUT", `${crm}/settings`, { modules: { booking: true, store: true }, settings: { publicPage: page } })).status, 200);
  const service = (await post("/services", { name: "Haircut", duration: 30, price: 50000 })).id;
  const hours = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, ["00:00", "24:00"]]));
  await post("/staff", { name: "Aziz", hours, serviceIds: [service] });
  const shampoo = (await post("/products", { name: "Shampoo", price: 40000, opening: 5 })).changes.set.products[0];
  const visitor = browser();
  const pub = (method, path, body) => visitor.call(method, `/public/crm/${slug}${path}`, body);
  const visit = (start) => ({ serviceIds: [service], start: `${day}T${start}`, name: "Dilnoza", phone: "+998 90 111 22 33" });
  const order = { lines: [{ productId: shampoo.id, variantId: shampoo.variants[0].id, qty: 1 }], name: "Madina", phone: "+998 93 444 55 66", delivery: { method: "pickup", date: day, window: { from: "12:00", to: "15:00" } }, payment: "cash" };
  const made = await pub("POST", "/bookings", visit("10:00"));
  assert.equal(made.status, 201, JSON.stringify(made.body));

  // Billed and never paid: the team's writes are refused, and so are the page's, in a code a page can show.
  crmBilled();
  assert.equal((await addCustomer(o)).status, 402);
  for (const [path, body] of [["/bookings", visit("11:00")], [`/bookings/${made.body.ref}/cancel`, { token: made.body.token }], ["/orders", order]]) {
    const r = await pub("POST", path, body);
    assert.deepEqual([r.status, r.body], [402, { message: "This isn't available right now.", code: "unavailable" }], path);
  }
  // Reads go on.
  for (const path of ["/", "/services", "/products", `/bookings/${made.body.ref}?token=${made.body.token}`]) assert.equal((await pub("GET", path)).status, 200, path);
  // Nothing about the page changes with the switch off.
  delete process.env.CRM_BILLING;
  assert.equal((await pub("POST", "/orders", order)).status, 201);
  assert.equal((await pub("POST", `/bookings/${made.body.ref}/cancel`, { token: made.body.token })).status, 200);
});
