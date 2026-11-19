// The link between the AI agent and the CRM, owned by the CRM (settings.ai): which agent, on which
// channels, how far in each module. Old workspaces (aiConnected / aiAct only) read through the
// normaliser without a migration. The bridge gives tools only to the chosen agent, on allowed
// channels, per module level, and asks again on Confirm.
import assert from "node:assert/strict";
import { test } from "node:test";
import { owner, teammate, crmOwner, query } from "./helpers/setup.js";
import { aiLink, levelsOf, mirrorOldKeys } from "../src/crm/core/ai-link.js";
import { crmTools, runCrmTool, decideCrmAction } from "../src/bridge/crm-tools.js";
import { nowIn, addDays, dayOf } from "../src/crm/shared/time.js";

const D = (n) => addDays(dayOf(nowIn("Asia/Tashkent", new Date())), n);
const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, ["00:00", "24:00"]]));
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const names = (entries) => entries.map((e) => e.tool.name).sort();
const READS = { booking: ["crm_free_times", "crm_list_services", "crm_my_bookings"], store: ["crm_find_products", "crm_my_orders", "crm_order_options"] };
const WRITES = { booking: ["crm_book", "crm_cancel_booking", "crm_move_booking"], store: ["crm_place_order"] };
const all = (...parts) => ["crm_identify_customer", ...parts.flat()].sort();

/* ───── The normaliser (pure) ───── */

test("old settings read as a link without any migration", () => {
  const agents = [
    { id: "a1", status: "draft" },
    { id: "a2", status: "active" },
    { id: "a3", status: "active" },
  ];
  const both = { booking: true, store: true };
  assert.deepEqual(aiLink({ aiConnected: false, aiAct: true }, both, agents), { agentId: null, channels: { widget: true, telegram: true }, booking: "act", store: "act" });
  // Connected: the oldest published agent, both channels, every module that is on at "act".
  assert.deepEqual(aiLink({ aiConnected: true, aiAct: true }, both, agents), { agentId: "a2", channels: { widget: true, telegram: true }, booking: "act", store: "act" });
  assert.deepEqual(aiLink({ aiConnected: true }, { booking: true, store: false }, agents), { agentId: "a2", channels: { widget: true, telegram: true }, booking: "act", store: "off" });
  // aiAct off: lookups only.
  assert.deepEqual(aiLink({ aiConnected: true, aiAct: false }, both, agents).booking, "answer");
  // None published: the oldest one; none at all: not connected.
  assert.equal(aiLink({ aiConnected: true }, both, [{ id: "d1", status: "draft" }, { id: "d2", status: "draft" }]).agentId, "d1");
  assert.equal(aiLink({ aiConnected: true }, both, []).agentId, null);
  // The new shape wins over the old keys; an agent that is gone reads as not connected.
  const saved = { agentId: "a3", channels: { widget: false, telegram: true }, booking: "answer", store: "off" };
  assert.deepEqual(aiLink({ aiConnected: false, ai: saved }, both, agents), saved);
  assert.equal(aiLink({ aiConnected: true, ai: { ...saved, agentId: "gone" } }, both, agents).agentId, null);
  // A module that is off has no level, whatever was saved.
  assert.deepEqual(levelsOf({ ...saved, store: "act" }, { booking: true, store: false }), { booking: "answer", store: "off" });
  // The old keys a new save keeps: never more than the link gives.
  assert.deepEqual(mirrorOldKeys(saved), { aiConnected: true, aiAct: false });
  assert.deepEqual(mirrorOldKeys({ ...saved, booking: "off" }), { aiConnected: false, aiAct: true });
  assert.deepEqual(mirrorOldKeys({ ...saved, booking: "act", store: "act", channels: { widget: false, telegram: false } }), { aiConnected: false, aiAct: true });
});

/* ───── Through the API ───── */

/**
 * A workspace with both products, the Booking and Store modules, two published agents (Aziza made
 * first) and a draft one, a specialist, a service and a product. Connected the old way.
 */
async function business() {
  const o = await owner("Dilnoza Rahimova", "Gulzor");
  const w = `/w/${o.ws.id}`;
  const crm = `${w}/crm`;
  const aziza = ok(await o.b.call("POST", `${w}/agents`, { name: "Aziza" }), 201);
  ok(await o.b.call("POST", `${w}/agents/${aziza.id}/publish`));
  // Past the plan's one agent: the rest are made in SQL.
  const more = async (name, status) =>
    (await query("INSERT INTO agents (workspace_id, name, status, created_at) VALUES ($1, $2, $3, now() + interval '1 minute') RETURNING *", [o.ws.id, name, status])).rows[0];
  const bek = await more("Bek", "active");
  const draft = await more("Draft one", "draft");
  ok(await o.b.call("POST", `${w}/products`, { add: "crm" }));
  ok(await o.b.call("PUT", `${crm}/settings`, { modules: { booking: true, store: true }, settings: { aiConnected: true } }));
  const service = ok(await o.b.call("POST", `${crm}/services`, { name: "Haircut", duration: 30, price: 50000 }), 201).id;
  const staff = ok(await o.b.call("POST", `${crm}/staff`, { name: "Aziz", hours: ALL_DAY, serviceIds: [service] }), 201).id;
  ok(await o.b.call("POST", `${crm}/products`, { name: "Red roses", price: 100000, opening: 5 }), 201);
  const row = (await query("SELECT * FROM agents WHERE id = $1", [aziza.id])).rows[0];
  const settings = (body) => o.b.call("PUT", `${crm}/settings`, { settings: body });
  const link = (ai) => settings({ ai: { agentId: row.id, channels: { widget: true, telegram: true }, booking: "act", store: "act", ...ai } });
  const snap = async () => ok(await o.b.call("GET", `${crm}/snapshot?only=settings`)).settings;
  const conversation = async (agent, channel) =>
    (await query("INSERT INTO conversations (workspace_id, agent_id, channel, visitor, visitor_token_hash) VALUES ($1, $2, $3, '{}', 'x') RETURNING id", [o.ws.id, agent.id, channel])).rows[0].id;
  return { o, w, crm, aziza: row, bek, draft, service, staff, settings, link, snap, conversation };
}

test("the snapshot and every settings save carry the link; the old switch reads as the oldest published agent", async () => {
  const s = await business();
  const before = await s.snap();
  assert.deepEqual(before.ai, { agentId: s.aziza.id, channels: { widget: true, telegram: true }, booking: "act", store: "act" });
  assert.equal(before.aiConnected, true);

  const saved = ok(await s.link({ agentId: s.bek.id, channels: { widget: false, telegram: true }, store: "answer" }));
  assert.deepEqual(saved.changes.top.settings.ai, { agentId: s.bek.id, channels: { widget: false, telegram: true }, booking: "act", store: "answer" });
  // The old keys are kept in step for code that reads only them.
  const stored = (await query("SELECT data->'settings' AS s FROM crm_settings WHERE workspace_id = $1", [s.o.ws.id])).rows[0].s;
  assert.deepEqual([stored.aiConnected, stored.aiAct], [true, false]);

  // An older app sends only the old keys: they take over again.
  ok(await s.settings({ aiConnected: false }));
  assert.deepEqual((await s.snap()).ai.agentId, null);
  assert.equal((await query("SELECT data->'settings' ? 'ai' AS has FROM crm_settings WHERE workspace_id = $1", [s.o.ws.id])).rows[0].has, false);

  // Disconnected in the new shape.
  ok(await s.link({ agentId: null }));
  assert.equal((await s.snap()).aiConnected, false);
});

test("the link names only an agent of this workspace; a deleted one reads as not connected", async () => {
  const s = await business();
  const other = await owner("Other Owner", "Elsewhere");
  const foreign = ok(await other.b.call("POST", `/w/${other.ws.id}/agents`, { name: "Not yours" }), 201);
  const refused = await s.link({ agentId: foreign.id });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "bad_agent");
  assert.equal((await s.link({ agentId: "not-a-uuid" })).status, 400);
  assert.equal((await s.link({ booking: "sometimes" })).status, 400);
  assert.equal((await s.settings({ ai: { agentId: null } })).status, 400, "saved whole");

  ok(await s.link({ agentId: s.bek.id }));
  ok(await s.o.b.call("DELETE", `${s.w}/agents/${s.bek.id}`), 204);
  const after = await s.snap();
  assert.equal(after.ai.agentId, null);
  assert.equal(after.aiConnected, false);
  assert.deepEqual(await crmTools(s.bek), []);

  // Only admins change it (a settings save).
  const mate = await teammate(s.o, "agent");
  assert.equal((await mate.b.call("PUT", `${s.crm}/settings`, { settings: { ai: { agentId: s.aziza.id, channels: { widget: true, telegram: true }, booking: "act", store: "act" } } })).status, 403);
  assert.equal((await mate.b.call("GET", `${s.crm}/agent-link`)).status, 200, "anyone may read it");
});

test("a CRM without the AI agent product keeps nothing connected", async () => {
  const o = await crmOwner();
  const r = ok(await o.b.call("PUT", `${o.crm}/settings`, { settings: { ai: { agentId: "7f1d6d1e-8a7b-4b1e-9c62-1f6c1b1d2e3f", channels: { widget: true, telegram: true }, booking: "act", store: "act" } } }));
  assert.equal(r.changes.top.settings.ai.agentId, null);
  assert.equal(r.changes.top.settings.aiConnected, false);
  assert.deepEqual(ok(await o.b.call("GET", `${o.crm}/agent-link`)), { agents: [], ai: null });
});

test("tools go to the chosen agent only, on allowed channels, at each module's level", async () => {
  const s = await business();
  const widget = await s.conversation(s.aziza, "widget");
  const telegram = await s.conversation(s.aziza, "telegram");
  const business_ = await s.conversation(s.aziza, "telegram_business");
  const bekChat = await s.conversation(s.bek, "widget");

  // Connected the old way: Aziza everywhere, every tool; Bek nothing.
  assert.deepEqual(names(await crmTools(s.aziza, widget)), all(READS.booking, READS.store, WRITES.booking, WRITES.store));
  assert.deepEqual(await crmTools(s.bek, bekChat), []);
  assert.deepEqual(await crmTools(s.bek), [], "not in the Playground either");
  // Another agent's conversation is never taken for the Playground.
  assert.deepEqual(await crmTools(s.aziza, bekChat), []);

  // Bek chosen: the tools move with the choice.
  ok(await s.link({ agentId: s.bek.id }));
  assert.deepEqual(await crmTools(s.aziza, widget), []);
  assert.equal((await crmTools(s.bek, bekChat)).length, 11);

  // Channels: website off, Telegram on (Telegram Business counts as Telegram). The Playground always works.
  ok(await s.link({ channels: { widget: false, telegram: true } }));
  assert.deepEqual(await crmTools(s.aziza, widget), []);
  assert.equal((await crmTools(s.aziza, telegram)).length, 11);
  assert.equal((await crmTools(s.aziza, business_)).length, 11);
  ok(await s.link({ channels: { widget: false, telegram: false } }));
  assert.deepEqual(await crmTools(s.aziza, telegram), []);
  assert.equal((await crmTools(s.aziza)).length, 11, "the Playground");
  assert.deepEqual((await runCrmTool({ agent: s.aziza, conversationId: telegram, tool: { name: "crm_list_services" }, args: {} })).output, { error: "unavailable" });

  // Levels: Bookings answers only, Orders off.
  ok(await s.link({ booking: "answer", store: "off" }));
  assert.deepEqual(names(await crmTools(s.aziza, widget)), all(READS.booking));
  ok(await s.link({ booking: "off", store: "act" }));
  assert.deepEqual(names(await crmTools(s.aziza, widget)), all(READS.store, WRITES.store));
  ok(await s.link({ booking: "off", store: "off" }));
  assert.deepEqual(await crmTools(s.aziza, widget), []);

  // A module switched off in the CRM has no tools, whatever its level.
  ok(await s.link({}));
  ok(await s.o.b.call("PUT", `${s.crm}/settings`, { modules: { booking: true, store: false } }));
  assert.deepEqual(names(await crmTools(s.aziza, widget)), all(READS.booking, WRITES.booking));

  // A draft agent can be chosen: its Playground works (the website and Telegram answer only once it is published).
  ok(await s.link({ agentId: s.draft.id }));
  assert.equal((await crmTools(s.draft)).length, 7);
});

test("Confirm asks again: a level lowered, a channel closed or another agent chosen after the card refuses it", async () => {
  const s = await business();
  const card = async () => {
    const cid = await s.conversation(s.aziza, "widget");
    const who = await runCrmTool({ agent: s.aziza, conversationId: cid, tool: { name: "crm_identify_customer" }, args: { phone: "+998977778899", name: "Malika" } });
    assert.deepEqual(who.output, { customer: "ready" });
    const res = await runCrmTool({ agent: s.aziza, conversationId: cid, tool: { name: "crm_book" }, args: { services: [s.service], start: `${D(2)}T10:00`, specialist: s.staff } });
    assert.equal(res.output.status, "waiting_for_customer", JSON.stringify(res.output));
    return { cid, action: res.card.action_id };
  };
  for (const change of [{ booking: "answer" }, { channels: { widget: false, telegram: true } }, { agentId: s.bek.id }]) {
    ok(await s.link({}));
    const c = await card();
    ok(await s.link(change));
    const out = await decideCrmAction(c.cid, c.action, true);
    assert.equal(out.status, "failed", JSON.stringify(change));
    assert.deepEqual(JSON.parse(out.error), { error: "unavailable" });
  }
  // Back as it was: the card goes through.
  ok(await s.link({}));
  const c = await card();
  assert.equal((await decideCrmAction(c.cid, c.action, true)).status, "done");
});

test("the reads: CRM settings see the agents and their real channels, the dashboard sees the link from the agent", async () => {
  const s = await business();
  await query("UPDATE agents SET allowed_origins = $2 WHERE id = $1", [s.aziza.id, ["https://www.gulzor.uz", "https://shop.gulzor.uz"]]);
  await query("INSERT INTO agent_channels (workspace_id, agent_id, type, config) VALUES ($1, $2, 'telegram', $3)", [s.o.ws.id, s.aziza.id, { account_id: "1001", account_name: "@gulzor_bot" }]);
  // Bek has no allowed site, but a website conversation: the website chat is his channel.
  await s.conversation(s.bek, "widget");
  ok(await s.link({ store: "answer", channels: { widget: true, telegram: false } }));

  const view = ok(await s.o.b.call("GET", `${s.crm}/agent-link`));
  assert.deepEqual(view.ai, { agentId: s.aziza.id, channels: { widget: true, telegram: false }, booking: "act", store: "answer" });
  assert.deepEqual(view.agents, [
    { id: s.aziza.id, name: "Aziza", status: "active", channels: [{ type: "widget", label: "gulzor.uz", more: 1, live: true }, { type: "telegram", label: "@gulzor_bot", live: true }] },
    { id: s.bek.id, name: "Bek", status: "active", channels: [{ type: "widget", label: null, more: 0, live: true }] },
    { id: s.draft.id, name: "Draft one", status: "draft", channels: [] },
  ]);

  assert.deepEqual(ok(await s.o.b.call("GET", `${s.w}/agents/${s.aziza.id}/crm`)), {
    crm: true,
    connected: true,
    modules: [{ module: "booking", level: "act" }, { module: "store", level: "answer" }],
    channels: ["widget"],
  });
  assert.deepEqual(ok(await s.o.b.call("GET", `${s.w}/agents/${s.bek.id}/crm`)), { crm: true, connected: false });
  assert.equal((await s.o.b.call("GET", `${s.w}/agents/7f1d6d1e-8a7b-4b1e-9c62-1f6c1b1d2e3f/crm`)).status, 404);

  // An AI agent workspace without the CRM: nothing to show.
  const plain = await owner("Plain Owner", "Plain");
  const agent = ok(await plain.b.call("POST", `/w/${plain.ws.id}/agents`, { name: "Solo" }), 201);
  assert.deepEqual(ok(await plain.b.call("GET", `/w/${plain.ws.id}/agents/${agent.id}/crm`)), { crm: false });
  assert.equal((await plain.b.call("GET", `/w/${plain.ws.id}/crm/agent-link`)).status, 404, "the CRM's routes need the CRM");
});
