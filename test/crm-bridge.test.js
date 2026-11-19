// The bridge: the AI agent working in the CRM for a customer in chat (src/bridge). Through the
// widget with the fake AI ("[tool:name {args}]" in a message runs that tool), and through
// runCrmTool where the whole answer of a tool matters. "Now" is the server's real clock in the
// workspace's time zone, so days are counted from today.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { owner, browser, query, base } from "./helpers/setup.js";
import { crmTools, runCrmTool, decideCrmAction } from "../src/bridge/crm-tools.js";
import { fakeAI } from "../src/agent/answers/ai.js";
import { nowIn, addDays, addMinutes, dayOf, hmOf, toMin } from "../src/crm/shared/time.js";

const now = () => nowIn("Asia/Tashkent", new Date());
const D = (n) => addDays(dayOf(now()), n);
const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, ["00:00", "24:00"]]));
const PNG = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(40, 5)]);
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const names = (entries) => entries.map((e) => e.tool.name).sort();
const BOOKING_TOOLS = ["crm_book", "crm_cancel_booking", "crm_free_times", "crm_list_services", "crm_move_booking", "crm_my_bookings"];
const STORE_TOOLS = ["crm_find_products", "crm_my_orders", "crm_order_options", "crm_place_order"];

/**
 * A workspace with the AI agent and the CRM: a published agent, two specialists who work around
 * the clock, two services, a team-made customer, and roses in stock. `settings` is sent to CRM settings.
 */
async function business({ settings = { aiConnected: true }, modules = { booking: true, store: true }, crm = true } = {}) {
  process.env.PUBLIC_API_URL = base;
  const o = await owner("Dilnoza Rahimova", "Gulzor");
  const w = `/w/${o.ws.id}`;
  const agent = ok(await o.b.call("POST", `${w}/agents`, { name: "Gulzor AI" }), 201);
  ok(await o.b.call("POST", `${w}/agents/${agent.id}/publish`));
  const row = (await query("SELECT * FROM agents WHERE id = $1", [agent.id])).rows[0];
  const s = { o, w, agent, row, key: agent.public_key, crm: `${w}/crm` };
  if (!crm) return s;
  ok(await o.b.call("POST", `${w}/products`, { add: "crm" }));
  ok(await o.b.call("PUT", `${s.crm}/settings`, { modules, settings }));
  const post = async (path, body) => ok(await o.b.call("POST", s.crm + path, body), 201);
  s.post = post;
  s.s1 = (await post("/services", { name: { en: "Haircut", ru: "Стрижка", uz: "Soch olish" }, duration: 30, price: 50000 })).id;
  s.s2 = (await post("/services", { name: "Colour", duration: 60, price: 90000 })).id;
  s.p1 = (await post("/staff", { name: "Aziz", role: "Barber", hours: ALL_DAY, serviceIds: [s.s1, s.s2] })).id;
  s.p2 = (await post("/staff", { name: "Bek", hours: ALL_DAY, serviceIds: [s.s1] })).id;
  s.team = (await post("/customers", { name: "Jasur Karimov", phone: "+998901234567" })).id;
  s.roses = (await post("/products", { name: "Red roses", price: 100000, opening: 5 })).id;
  return s;
}

/** A visitor's chat on the widget: say(text) answers with the new messages; tool(name, args) runs one tool. */
async function chat(s) {
  const v = browser();
  const start = ok(await v.call("POST", `/widget/${s.key}/conversations`, {}), 201);
  const vt = { "X-Visitor-Token": start.visitor_token };
  const path = `/widget/${s.key}/conversations/${start.conversation_id}`;
  const say = async (text) => ok(await v.call("POST", `${path}/messages`, { text }, vt)).messages.at(-1);
  return {
    cid: start.conversation_id,
    say,
    tool: (name, args = {}) => say(`[tool:${name} ${JSON.stringify(args)}]`),
    decide: (actionId, yes = true) => v.call("POST", `${path}/actions/${actionId}/${yes ? "confirm" : "cancel"}`, {}, vt),
    // The whole answer of a tool, as the model gets it.
    run: (name, args = {}) => runCrmTool({ agent: s.row, conversationId: start.conversation_id, tool: { name }, args }),
  };
}
const snapshot = async (s, only) => ok(await s.o.b.call("GET", `${s.crm}/snapshot?only=${only}`));
const failure = (message) => JSON.parse(message.body.replace(/^Failed: /, ""));
/** A start for the team that is less than `cancelUntil` (120 min) away, yet past the notice, and ends the same day. */
const soon = () => [75, 85, 95, 105].map((m) => addMinutes(now(), m)).map((t) => `${t.slice(0, 15)}0`).find((t) => toMin(hmOf(t)) + 30 <= 1440);

test("without both products, the connection and a module the agent gets no CRM tools and answers as before", async () => {
  // The AI agent alone: the same message gets the same answer as before the bridge, with no tools in the prompt.
  const plain = await business({ crm: false });
  assert.deepEqual(await crmTools(plain.row), []);
  const c = await chat(plain);
  const reply = await c.tool("crm_list_services");
  assert.equal(reply.kind, "fallback");
  assert.doesNotMatch(fakeAI.lastAnswer.system, /You can use tools/);

  // Both products, but the AI agent isn't connected in CRM settings.
  const off = await business({ settings: { aiConnected: false } });
  assert.deepEqual(await crmTools(off.row), []);
  assert.equal((await chat(off).then((x) => x.tool("crm_list_services"))).kind, "fallback");
  assert.deepEqual((await (await chat(off)).run("crm_list_services")).output, { error: "unavailable" });

  // Connected, but no module is on.
  const none = await business({ modules: { booking: false, store: false } });
  assert.deepEqual(await crmTools(none.row), []);

  // Only what is on: Booking alone has no Store tools, and the other way round.
  const bookingOnly = await business({ modules: { booking: true, store: false } });
  assert.deepEqual(names(await crmTools(bookingOnly.row)), ["crm_identify_customer", ...BOOKING_TOOLS].sort());
  assert.deepEqual((await (await chat(bookingOnly)).run("crm_find_products")).output, { error: "unavailable" });
  const storeOnly = await business({ modules: { booking: false, store: true } });
  assert.deepEqual(names(await crmTools(storeOnly.row)), ["crm_identify_customer", ...STORE_TOOLS].sort());

  // aiAct off: the agent may look things up, never change anything.
  const readOnly = await business({ settings: { aiConnected: true, aiAct: false } });
  assert.deepEqual(names(await crmTools(readOnly.row)), ["crm_find_products", "crm_free_times", "crm_identify_customer", "crm_list_services", "crm_my_bookings", "crm_my_orders", "crm_order_options"]);
  assert.deepEqual((await (await chat(readOnly)).run("crm_book", { services: [readOnly.s1], start: `${D(2)}T10:00` })).output, { error: "unavailable" });

  // The CRM billed and not paid for: the agent may look things up, as the team may, and never change anything.
  const unpaid = await business();
  Object.assign(process.env, { POLAR_ACCESS_TOKEN: "test-token", CRM_BILLING: "on" });
  try {
    assert.deepEqual(names(await crmTools(unpaid.row)), names(await crmTools(readOnly.row)));
    assert.deepEqual((await (await chat(unpaid)).run("crm_book", { services: [unpaid.s1], start: `${D(2)}T10:00` })).output, { error: "unavailable" });
  } finally {
    delete process.env.POLAR_ACCESS_TOKEN;
    delete process.env.CRM_BILLING;
  }
  assert.ok(names(await crmTools(unpaid.row)).includes("crm_book"), "with the billing switch off nothing changes");

  // On: the tools reach the model, under the workspace's name.
  const on = await business();
  const tools = await crmTools(on.row);
  assert.deepEqual(names(tools), ["crm_identify_customer", ...BOOKING_TOOLS, ...STORE_TOOLS].sort());
  assert.ok(tools.every((t) => t.integration.crm && t.integration.id === null && t.integration.name === "Gulzor" && /\S/.test(t.tool.when)));
  assert.equal(tools.find((t) => t.tool.name === "crm_book").tool.kind, "write");
  await (await chat(on)).say("hello there");
  assert.match(fakeAI.lastAnswer.system, /You can use tools .* in: Gulzor/);
});

test("booking through a conversation: who the customer is, services, free times, the card, Confirm", async () => {
  const s = await business();
  const c = await chat(s);
  // Nobody is known yet: the tools say what to ask for.
  assert.deepEqual((await c.run("crm_my_bookings")).output, { error: "customer_unknown", missing: ["name", "phone"] });
  assert.deepEqual((await c.run("crm_identify_customer", { name: "Aziza" })).output, { error: "customer_unknown", missing: ["phone"] });
  assert.deepEqual((await c.run("crm_identify_customer", { phone: "12345" })).output, { error: "bad_phone" });
  const who = await c.tool("crm_identify_customer", { phone: "+998 90 111 22 33", name: "Aziza" });
  assert.match(who.body, /"customer":"ready"/);

  const list = (await c.run("crm_list_services", { language: "ru" })).output;
  assert.deepEqual(list.services.map((x) => [x.name, x.minutes, x.priceText]), [["Стрижка", 30, "50 000 сум"], ["Colour", 60, "90 000 сум"]]);
  assert.deepEqual(list.specialists.find((p) => p.name === "Aziz").services, [s.s1, s.s2]);

  const times = (await c.run("crm_free_times", { services: [s.s1], day: D(2) })).output;
  assert.equal(times.minutes, 30);
  assert.equal(times.times[0].start, `${D(2)}T00:00`);
  assert.equal(times.more, true);
  assert.deepEqual((await c.run("crm_free_times", { services: [s.s1], day: D(-1) })).output.none, { code: "day_passed" });
  assert.equal((await c.tool("crm_free_times", { services: [s.s1], day: D(2) })).body.startsWith("crm_free_times →"), true);

  // A time that isn't on the grid is never offered to a customer.
  const offGrid = (await c.run("crm_book", { services: [s.s1], start: `${D(2)}T10:07`, specialist: s.p1 })).output;
  assert.equal(offGrid.error, "rules");
  assert.deepEqual(offGrid.soft, [{ code: "off_grid", step: 15 }]);
  assert.ok(offGrid.times.length > 0);

  const proposal = await c.tool("crm_book", { services: [s.s1], start: `${D(2)}T10:00`, specialist: s.p1, language: "uz" });
  assert.equal(proposal.body, "Please check the details and press Confirm.");
  const card = proposal.card;
  assert.equal(card.type, "confirm");
  assert.equal(card.status, "pending");
  assert.equal(card.integration_id, null);
  assert.equal(card.title, "Yangi bron");
  assert.deepEqual(card.lines[0], ["Xizmat", "Soch olish"]);
  assert.match(card.lines[1][1], /, 10:00$/);
  assert.deepEqual(card.lines[2], ["Mutaxassis", "Aziz"]);
  assert.equal(card.total, "Jami: 50 000 soʻm");
  // Nothing is written before Confirm: no booking, no customer.
  assert.equal((await snapshot(s, "appointments")).appointments.length, 0);
  assert.equal((await snapshot(s, "customers")).customers.length, 1);
  assert.deepEqual((await query("SELECT source, integration_id, status FROM pending_actions WHERE id = $1", [card.action_id])).rows[0], { source: "crm", integration_id: null, status: "pending" });

  const done = ok(await c.decide(card.action_id));
  assert.equal(done.messages.at(-1).body, "Done.");
  const [a] = (await snapshot(s, "appointments")).appointments;
  assert.equal(a.source, "ai");
  assert.equal(a.status, "new", "a customer's booking starts in the first step of the list");
  assert.equal(a.start, `${D(2)}T10:00`);
  assert.equal(a.staffId, s.p1);
  assert.equal(a.price, 50000);
  const added = (await snapshot(s, "customers")).customers.find((x) => x.id === a.customerId);
  assert.deepEqual([added.name, added.phone, added.source], ["Aziza", "+998901112233", "ai"]);
  assert.equal(ok(await c.decide(card.action_id), 409).message, "This request was already handled.");

  // Their own bookings; a phone typed in the chat stays "ready", never "known".
  const mine = (await c.run("crm_my_bookings")).output.bookings;
  assert.deepEqual(mine.map((b) => [b.booking, b.services, b.specialist, b.canChange]), [[a.id, "Haircut", "Aziz", true]]);
  assert.deepEqual((await c.run("crm_identify_customer")).output, { customer: "ready" });

  // "Anyone": the first specialist free then.
  const any = await c.tool("crm_book", { services: [s.s1], start: `${D(2)}T10:00` });
  assert.deepEqual(any.card.lines[2], ["Specialist", "Any free specialist"]);
  ok(await c.decide(any.card.action_id));
  const both = (await snapshot(s, "appointments")).appointments.filter((x) => x.start === `${D(2)}T10:00`);
  assert.deepEqual(both.map((x) => x.staffId).sort(), [s.p1, s.p2].sort());
});

test("the time is taken between the offer and Confirm: a refusal with codes and the times free now", async () => {
  const s = await business();
  const c = await chat(s);
  await c.run("crm_identify_customer", { phone: "+998901112233", name: "Aziza" });
  const { card } = await c.run("crm_book", { services: [s.s1], start: `${D(3)}T11:00`, specialist: s.p1 });
  // The team books the same time for someone else meanwhile.
  ok(await s.o.b.call("POST", `${s.crm}/appointments`, { customerId: s.team, staffId: s.p1, serviceIds: [s.s1], start: `${D(3)}T11:00` }), 201);
  const answer = ok(await c.decide(card.action_id)).messages.at(-1);
  const why = failure(answer);
  assert.equal(why.error, "rules");
  assert.deepEqual(why.hard, [{ code: "taken" }], "nothing about the other customer's booking reaches the chat");
  assert.ok(why.times.length > 0 && why.times.every((t) => t.start !== `${D(3)}T11:00`));
  const appts = (await snapshot(s, "appointments")).appointments;
  assert.deepEqual(appts.map((x) => x.source), [""]);
  // Nothing was added for the customer either: the write that would have added them was refused whole.
  assert.equal((await snapshot(s, "customers")).customers.length, 1);
  assert.equal((await query("SELECT status FROM pending_actions WHERE id = $1", [card.action_id])).rows[0].status, "failed");
});

test("Cancel on the card changes nothing", async () => {
  const s = await business();
  const c = await chat(s);
  await c.run("crm_identify_customer", { phone: "+998901112233", name: "Aziza" });
  const proposal = await c.tool("crm_book", { services: [s.s2], start: `${D(4)}T09:00`, specialist: s.p1 });
  const answer = ok(await c.decide(proposal.card.action_id, false)).messages.at(-1);
  assert.equal(answer.body, "Cancelled.");
  assert.equal((await snapshot(s, "appointments")).appointments.length, 0);
  assert.equal((await snapshot(s, "customers")).customers.length, 1);
  ok(await c.decide(proposal.card.action_id), 409);
});

test("a customer moves and cancels their own booking; inside the cutoff the tools refuse and offer the team", async () => {
  const s = await business();
  const c = await chat(s);
  await c.run("crm_identify_customer", { phone: "+998901112233", name: "Aziza" });
  ok(await c.decide((await c.run("crm_book", { services: [s.s1], start: `${D(2)}T10:00`, specialist: s.p1 })).card.action_id));
  const [a] = (await snapshot(s, "appointments")).appointments;

  // Move: the same specialist at another time; refused at a taken one, with times to offer.
  ok(await s.o.b.call("POST", `${s.crm}/appointments`, { customerId: s.team, staffId: s.p1, serviceIds: [s.s1], start: `${D(2)}T12:00` }), 201);
  const taken = (await c.run("crm_move_booking", { booking: a.id, start: `${D(2)}T12:00` })).output;
  assert.deepEqual([taken.error, taken.hard], ["rules", [{ code: "taken" }]]);
  const move = await c.tool("crm_move_booking", { booking: a.id, start: `${D(2)}T13:00`, language: "ru" });
  assert.equal(move.card.title, "Перенести запись");
  assert.match(move.card.lines[1][1], /10:00$/);
  assert.match(move.card.lines[2][1], /13:00$/);
  ok(await c.decide(move.card.action_id));
  const moved = (await snapshot(s, "appointments")).appointments.find((x) => x.id === a.id);
  assert.equal(moved.start, `${D(2)}T13:00`);
  assert.deepEqual(moved.history.at(-1), { ...moved.history.at(-1), type: "moved", from: `${D(2)}T10:00`, to: `${D(2)}T13:00`, via: "ai" });

  // Cancel: into the cancelled step, the record kept.
  const cancel = await c.tool("crm_cancel_booking", { booking: a.id });
  assert.equal(cancel.card.title, "Cancel the booking");
  ok(await c.decide(cancel.card.action_id));
  const cancelled = (await snapshot(s, "appointments")).appointments.find((x) => x.id === a.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.history.at(-1).via, "ai");
  assert.deepEqual((await c.run("crm_my_bookings")).output.bookings.filter((b) => b.booking === a.id), []);
  assert.deepEqual((await c.run("crm_cancel_booking", { booking: a.id })).output, { error: "booking_closed", handoff: true });

  // A visit they booked that the team moved to less than rules.cancelUntil (120 min) from now.
  ok(await c.decide((await c.run("crm_book", { services: [s.s1], start: `${D(3)}T09:00`, specialist: s.p2 })).card.action_id));
  const close = (await snapshot(s, "appointments")).appointments.find((x) => x.start === `${D(3)}T09:00`).id;
  ok(await s.o.b.call("PUT", `${s.crm}/appointments/${close}`, { start: soon() }));
  const listed = (await c.run("crm_my_bookings")).output.bookings.find((b) => b.booking === close);
  assert.equal(listed.canChange, false);
  assert.deepEqual((await c.run("crm_cancel_booking", { booking: close })).output, { error: "cancel_closed", minutes: 120, handoff: true });
  assert.deepEqual((await c.run("crm_move_booking", { booking: close, start: `${D(3)}T10:00` })).output, { error: "cancel_closed", minutes: 120, handoff: true });
  const said = await c.tool("crm_cancel_booking", { booking: close });
  assert.equal(said.body, "crm_cancel_booking: cancel_closed");
  assert.equal(said.card, null);
});

test("one conversation never reaches another customer's bookings or orders, whatever ids it guesses", async () => {
  const s = await business();
  const a = await chat(s);
  await a.run("crm_identify_customer", { phone: "+998901112233", name: "Aziza" });
  ok(await a.decide((await a.run("crm_book", { services: [s.s1], start: `${D(2)}T10:00`, specialist: s.p1 })).card.action_id));
  ok(await a.decide((await a.run("crm_place_order", { lines: [{ product: s.roses, qty: 1 }], delivery: { method: "pickup" } })).card.action_id));
  const [booking] = (await snapshot(s, "appointments")).appointments;
  const [order] = (await snapshot(s, "orders")).orders;
  // The team's own booking for its customer.
  const teamBooking = ok(await s.o.b.call("POST", `${s.crm}/appointments`, { customerId: s.team, staffId: s.p2, serviceIds: [s.s1], start: `${D(5)}T10:00` }), 201).id;

  // Another customer, who knows (or guesses) the ids.
  const b = await chat(s);
  await b.run("crm_identify_customer", { phone: "+998935556677", name: "Bobur" });
  for (const id of [booking.id, teamBooking]) {
    assert.deepEqual((await b.run("crm_cancel_booking", { booking: id })).output, { error: "not_found" });
    assert.deepEqual((await b.run("crm_move_booking", { booking: id, start: `${D(6)}T10:00` })).output, { error: "not_found" });
  }
  assert.deepEqual((await b.run("crm_my_bookings")).output, { bookings: [] });
  assert.deepEqual((await b.run("crm_my_orders")).output, { orders: [] });
  // An id from another workspace, or no id at all, reads the same.
  assert.deepEqual((await b.run("crm_cancel_booking", { booking: "00000000-0000-0000-0000-000000000000" })).output, { error: "not_found" });
  assert.equal((await b.run("crm_cancel_booking", { booking: "x" })).output.error, "bad_input");

  // Someone who types the team customer's phone acts for them, but sees only what their own chat made.
  const c = await chat(s);
  assert.deepEqual((await c.run("crm_identify_customer", { phone: "+998901234567", name: "Jasur" })).output, { customer: "ready" });
  assert.deepEqual((await c.run("crm_my_bookings")).output, { bookings: [] });
  assert.deepEqual((await c.run("crm_cancel_booking", { booking: teamBooking })).output, { error: "not_found" });
  const own = await c.run("crm_book", { services: [s.s2], start: `${D(7)}T10:00`, specialist: s.p1 });
  ok(await c.decide(own.card.action_id));
  const ownBookings = (await c.run("crm_my_bookings")).output.bookings;
  assert.equal(ownBookings.length, 1);
  assert.notEqual(ownBookings[0].booking, teamBooking);
  // ... while the team's customer did get the booking.
  assert.equal((await snapshot(s, "appointments")).appointments.find((x) => x.id === ownBookings[0].booking).customerId, s.team);

  // A card belongs to its conversation: another chat can't press it.
  const pending = await a.run("crm_cancel_booking", { booking: booking.id });
  assert.equal(await decideCrmAction(b.cid, pending.card.action_id, true), null);
  ok(await b.decide(pending.card.action_id), 404);
  assert.equal((await query("SELECT status FROM pending_actions WHERE id = $1", [pending.card.action_id])).rows[0].status, "pending");
  // And the first customer still sees exactly their own.
  assert.deepEqual((await a.run("crm_my_orders")).output.orders.map((o) => o.order), [order.id]);
});

test("a Telegram chat is known by its Telegram account, and a new customer keeps the handle", async () => {
  const s = await business();
  ok(await s.o.b.call("PUT", `${s.crm}/customers/${s.team}`, { telegram: "@Jasur_K" }));
  const conversation = async (user, username) =>
    (
      await query(
        "INSERT INTO conversations (workspace_id, agent_id, channel, visitor, visitor_token_hash) VALUES ($1, $2, 'telegram', $3, 'x') RETURNING id",
        [s.o.ws.id, s.agent.id, { name: "Telegram user", telegram_user_id: user, telegram_username: username }]
      )
    ).rows[0].id;
  const run = (cid, name, args = {}) => runCrmTool({ agent: s.row, conversationId: cid, tool: { name }, args }).then((r) => r.output);

  // The team saved this customer with the handle: no phone needed.
  const known = await conversation("777", "jasur_k");
  ok(await s.o.b.call("POST", `${s.crm}/appointments`, { customerId: s.team, staffId: s.p1, serviceIds: [s.s1], start: `${D(2)}T09:00` }), 201);
  assert.equal((await run(known, "crm_my_bookings")).bookings.length, 1);
  assert.deepEqual(await run(known, "crm_identify_customer"), { customer: "known", name: "Jasur Karimov" });

  // Someone new on Telegram: added with their handle on Confirm, and found again in their next chat.
  const first = await conversation("888", "malika_a");
  assert.deepEqual(await run(first, "crm_identify_customer", { phone: "+998977778899", name: "Malika" }), { customer: "ready" });
  const res = await runCrmTool({ agent: s.row, conversationId: first, tool: { name: "crm_book" }, args: { services: [s.s1], start: `${D(2)}T15:00` } });
  const outcome = await decideCrmAction(first, res.card.action_id, true);
  assert.equal(outcome.status, "done");
  const malika = (await snapshot(s, "customers")).customers.find((x) => x.name === "Malika");
  assert.deepEqual([malika.telegram, malika.source], ["malika_a", "ai"], "the handle kept bare, as the team's are");
  const next = await conversation("888", "malika_a");
  assert.equal((await run(next, "crm_my_bookings")).bookings.length, 1);
});

test("store through a conversation: products as cards with photos, delivery options, an order on Confirm, its status", async () => {
  const s = await business();
  const f = new FormData();
  f.append("file", new Blob([PNG]), "roses.png");
  const image = ok(await s.o.b.call("POST", `${s.crm}/products/images`, f), 201).image;
  ok(await s.o.b.call("PUT", `${s.crm}/products/${s.roses}`, { image }));
  const shirt = (await s.post("/products", { name: "Gift box", options: [{ id: "size", name: "Size", values: ["S", "M", "L"] }], variants: [{ values: { size: "S" }, price: 40000, opening: 2 }, { values: { size: "M" }, price: 45000, opening: 1 }, { values: { size: "L" }, price: 50000 }] })).id;
  const hidden = (await s.post("/products", { name: "Old roses", price: 1000, opening: 3, onSale: false })).id;
  const c = await chat(s);

  const shown = await c.tool("crm_find_products", { search: "roses" });
  assert.equal(shown.card.type, "products");
  assert.deepEqual(shown.card.items.map((i) => [i.title, i.price]), [["Red roses", "100 000 soʻm"]]);
  const photo = await fetch(shown.card.items[0].image);
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get("content-type"), "image/png");
  assert.equal((await fetch(`${base}/widget/${s.key}/crm-media/${"0".repeat(8)}-0000-0000-0000-000000000000.png`)).status, 404);
  const all = (await c.run("crm_find_products")).output;
  assert.deepEqual(all.products.map((p) => p.name).sort(), ["Gift box", "Red roses"], "off sale is never offered");
  const box = all.products.find((p) => p.id === shirt);
  assert.deepEqual(box.variants.map((v) => [v.option, v.left]), [["S", 2], ["M", 1]], "only what is left");
  assert.equal(box.choices, "Size: S, M");
  assert.equal(all.products.some((p) => p.id === hidden), false);
  // The description: found by a word in it, and shown to the agent (cut short when long).
  ok(await s.o.b.call("PUT", `${s.crm}/products/${shirt}`, { description: `A box with peonies inside.\n${"x".repeat(500)}` }));
  const byText = (await c.run("crm_find_products", { search: "peonies" })).output;
  assert.deepEqual(byText.products.map((p) => p.name), ["Gift box"]);
  assert.ok(byText.products[0].description.startsWith("A box with peonies inside."));
  assert.ok(byText.products[0].description.length <= 401 && byText.products[0].description.endsWith("…"));
  assert.equal("description" in all.products.find((p) => p.id === s.roses), false, "no description, no field");

  const options = (await c.run("crm_order_options", { day: D(1) })).output;
  assert.deepEqual(options.delivery.map((m) => [m.method, m.needsAddress, m.fee]), [["courier", true, 30000], ["pickup", false, 0]]);
  assert.deepEqual(options.day.windows, ["09:00–12:00", "12:00–15:00", "15:00–18:00", "18:00–21:00"]);
  assert.deepEqual((await c.run("crm_order_options", { day: D(-1) })).output.day.problem, { code: "past_day" });

  // Refusals are codes the agent turns into a question.
  assert.deepEqual((await c.run("crm_place_order", { lines: [{ product: s.roses, qty: 1 }], delivery: { method: "pickup" } })).output, { error: "customer_unknown", missing: ["name", "phone"] });
  await c.run("crm_identify_customer", { phone: "+998901112233", name: "Aziza" });
  const refuse = async (args) => (await c.run("crm_place_order", args)).output;
  assert.deepEqual(await refuse({ lines: [{ product: shirt, qty: 1 }], delivery: { method: "pickup" } }), { error: "variant_required", product: shirt, variants: box.variants.map((v) => ({ variant: v.variant, option: v.option })) });
  assert.deepEqual(await refuse({ lines: [{ product: s.roses, qty: 6 }], delivery: { method: "pickup" } }), { error: "short", product: s.roses, variant: (await snapshot(s, "products")).products.find((p) => p.id === s.roses).variants[0].id, left: 5 });
  assert.deepEqual(await refuse({ lines: [{ product: hidden, qty: 1 }], delivery: { method: "pickup" } }), { error: "off_sale", product: hidden });
  assert.deepEqual(await refuse({ lines: [{ product: s.roses, qty: 1 }], delivery: { method: "courier" } }), { error: "address_required" });
  assert.deepEqual(await refuse({ lines: [{ product: s.roses, qty: 1 }], delivery: { method: "boat" } }), { error: "bad_delivery" });
  assert.deepEqual(await refuse({ lines: [{ product: s.roses, qty: 1 }], delivery: { method: "pickup", day: D(1), window: "10:00-11:00" } }), { error: "bad_window", time: "both" });
  assert.deepEqual((await refuse({ lines: [{ product: s.roses, qty: 1 }], delivery: { method: "pickup", day: D(-1), window: "12:00-15:00" } })).hard, [{ code: "past_day" }]);
  assert.deepEqual(await refuse({ lines: [{ product: s.roses, qty: 1 }], delivery: { method: "pickup", day: D(1) } }), { error: "window_required", time: "both" });
  assert.equal((await refuse({ lines: [{ product: s.roses, qty: 1 }], delivery: { method: "pickup", day: D(40), time: "12:00" } })).error, "rules");
  assert.deepEqual(await refuse({ lines: [{ product: s.roses, qty: 1 }], delivery: { method: "pickup" }, payment: "gold" }), { error: "bad_payment" });
  ok(await s.o.b.call("PUT", `${s.crm}/settings`, { fields: { order: [{ id: "card", name: "Card text", type: "text", required: true }] } }));
  assert.deepEqual(await refuse({ lines: [{ product: s.roses, qty: 1 }], delivery: { method: "pickup" } }), { error: "rules", hard: [{ code: "field_required", field: "card" }], soft: [] });
  ok(await s.o.b.call("PUT", `${s.crm}/settings`, { fields: { order: [] } }));

  const proposal = await c.tool("crm_place_order", { lines: [{ product: s.roses, qty: 2 }], delivery: { method: "courier", address: "Chilonzor 5", day: D(1), window: "12:00-15:00" }, payment: "cash" });
  const card = proposal.card;
  assert.equal(card.title, "New order");
  assert.deepEqual(card.lines[0], ["Red roses × 2", "200 000 soʻm"]);
  assert.match(card.lines[1][1], /^Courier, .*, 12:00–15:00$/);
  assert.deepEqual(card.lines.slice(2), [["Address", "Chilonzor 5"], ["Delivery fee", "30 000 soʻm"], ["Payment", "Cash"]]);
  assert.equal(card.total, "Total: 230 000 soʻm");
  assert.equal((await snapshot(s, "orders")).orders.length, 0, "nothing is ordered before Confirm");

  assert.equal(ok(await c.decide(card.action_id)).messages.at(-1).body, "Done.");
  const [order] = (await snapshot(s, "orders")).orders;
  assert.deepEqual([order.source, order.status, order.totals.total, order.delivery.slot, order.delivery.fee, order.payment], ["ai", "new", 230000, "12:00–15:00", 30000, "cash"]);
  const customer = (await snapshot(s, "customers")).customers.find((x) => x.id === order.customerId);
  assert.deepEqual([customer.name, customer.source], ["Aziza", "ai"]);

  const mine = (await c.run("crm_my_orders", { language: "uz" })).output.orders;
  assert.deepEqual(mine.map((o) => [o.number, o.step, o.kind, o.totalText, o.items]), [[order.number, "Yangi", "open", "230 000 soʻm", [{ name: "Red roses", option: "", qty: 2 }]]]);

  // What was on the card is asked again on Confirm: the stock went meanwhile.
  const second = await c.run("crm_place_order", { lines: [{ product: shirt, variant: box.variants[0].variant, qty: 2 }], delivery: { method: "pickup" } });
  ok(await s.o.b.call("POST", `${s.crm}/stock/write-off`, { variantId: box.variants[0].variant, qty: 1, reason: "damaged" }));
  const outcome = await decideCrmAction(c.cid, second.card.action_id, true);
  assert.equal(outcome.status, "failed");
  assert.deepEqual(JSON.parse(outcome.error), { error: "rules", hard: [{ code: "short", left: 1 }], soft: [] });
  assert.equal((await snapshot(s, "orders")).orders.length, 1);

  // And the price changed meanwhile: refused, not sold at a price nobody saw.
  const third = await c.run("crm_place_order", { lines: [{ product: s.roses, qty: 1 }], delivery: { method: "pickup" } });
  ok(await s.o.b.call("PUT", `${s.crm}/products/${s.roses}`, { price: 120000 }));
  const repriced = await decideCrmAction(c.cid, third.card.action_id, true);
  assert.deepEqual(JSON.parse(repriced.error).hard.map((r) => r.code), ["price_changed"]);

  // A product taken off sale takes its photo out of every chat.
  ok(await s.o.b.call("PUT", `${s.crm}/products/${s.roses}`, { onSale: false }));
  assert.equal((await fetch(shown.card.items[0].image)).status, 404);
});

test("booking fields the business needs: listed for the agent to ask, shown on the card, marked for the team when not given", async () => {
  const s = await business();
  ok(await s.o.b.call("PUT", `${s.crm}/settings`, { fields: { appointment: [{ id: "allergy", name: { en: "Allergies", ru: "Аллергия", uz: "Allergiya" }, type: "text", required: true }, { id: "room", name: "Room", type: "number" }, { id: "deposit", name: "Deposit taken", type: "yesno" }, { id: "staffnote", name: "Staff note", type: "text" }] } }));
  const c = await chat(s);
  assert.deepEqual((await c.run("crm_list_services", { language: "ru" })).output.fields, [{ field: "allergy", name: "Аллергия", type: "text" }]);
  await c.run("crm_identify_customer", { phone: "+998901112233", name: "Aziza" });
  assert.deepEqual((await c.run("crm_book", { services: [s.s1], start: `${D(2)}T10:00`, fields: { allergy: 5 } })).output, { error: "bad_fields", fields: ["allergy"] });
  // The team's own fields are not the customer's to fill: left out of the card and of the booking.
  const given = await c.run("crm_book", { services: [s.s1], start: `${D(2)}T10:00`, specialist: s.p1, fields: { allergy: "None", room: 4, deposit: true, staffnote: "VIP, free of charge" } });
  assert.deepEqual(given.card.lines.slice(3), [["Allergies", "None"]]);
  ok(await c.decide(given.card.action_id));
  ok(await c.decide((await c.run("crm_book", { services: [s.s1], start: `${D(2)}T11:00`, specialist: s.p1 })).card.action_id));
  const [first, second] = (await snapshot(s, "appointments")).appointments;
  assert.deepEqual([first.fields, first.history], [{ allergy: "None" }, []]);
  // Who made it: the customer, through the AI agent.
  assert.deepEqual(first.createdBy, { by: "", byId: null, customer: true, via: "ai" });
  assert.deepEqual(second.history.map((h) => [h.type, h.fields, h.customer, h.via]), [["missing", ["allergy"], true, "ai"]]);
});

test("a module switched off after the offer, bad inputs and unknown services are refused as codes", async () => {
  const s = await business();
  const c = await chat(s);
  await c.run("crm_identify_customer", { phone: "+998901112233", name: "Aziza" });
  assert.equal((await c.run("crm_book", { services: [s.s1] })).output.error, "bad_input");
  assert.equal((await c.run("crm_free_times", { services: [s.s1], day: "tomorrow" })).output.error, "bad_input");
  assert.deepEqual((await c.run("crm_free_times", { services: [s.team], day: D(2) })).output, { error: "bad_service", service: s.team });
  ok(await s.o.b.call("PUT", `${s.crm}/services/${s.s2}`, { active: false }));
  assert.deepEqual((await c.run("crm_book", { services: [s.s2], start: `${D(2)}T10:00` })).output, { error: "bad_service", service: s.s2 });
  assert.equal((await c.run("crm_list_services")).output.services.some((x) => x.service === s.s2), false);

  // The Playground has no conversation: lookups work, nothing about a customer does.
  const playground = (name) => runCrmTool({ agent: s.row, conversationId: null, tool: { name }, args: {} }).then((r) => r.output);
  assert.equal((await playground("crm_list_services")).services.length, 1);
  assert.deepEqual(await playground("crm_my_bookings"), { error: "no_conversation" });
  assert.deepEqual(await playground("crm_identify_customer"), { error: "no_conversation" });

  const { card } = await c.run("crm_book", { services: [s.s1], start: `${D(2)}T10:00` });
  ok(await s.o.b.call("PUT", `${s.crm}/settings`, { modules: { booking: false, store: true } }));
  const answer = ok(await c.decide(card.action_id)).messages.at(-1);
  assert.deepEqual(failure(answer), { error: "unavailable" });
  assert.equal((await snapshot(s, "appointments")).appointments.length, 0);
});

/** A chat of this Telegram account, saved as the Telegram channel saves one; run and decide as in chat(). */
async function telegram(s, user, username) {
  const { rows } = await query(
    "INSERT INTO conversations (workspace_id, agent_id, channel, visitor, visitor_token_hash) VALUES ($1, $2, 'telegram', $3, 'x') RETURNING id",
    [s.o.ws.id, s.agent.id, { name: "Telegram user", telegram_user_id: user, telegram_username: username }]
  );
  const cid = rows[0].id;
  return { cid, run: (name, args = {}) => runCrmTool({ agent: s.row, conversationId: cid, tool: { name }, args }), decide: (id, yes = true) => decideCrmAction(cid, id, yes) };
}

test("a customer added from a phone typed in a chat sees only what their own chats made, in their next Telegram chat too", async () => {
  const s = await business();
  const phone = "+998935550011"; // someone else's number, not in the CRM yet
  const first = await telegram(s, "999", "mallory_x");
  await first.run("crm_identify_customer", { phone, name: "Mallory" });
  const proposal = await first.run("crm_book", { services: [s.s1], start: `${D(1)}T08:00`, specialist: s.p1 });
  assert.equal((await first.decide(proposal.card.action_id)).status, "done");
  const [own] = (await snapshot(s, "appointments")).appointments;
  // The number's real owner calls the business: the team finds that customer by the phone and books them.
  const taken = await s.o.b.call("POST", `${s.crm}/customers`, { name: "Real owner", phone });
  assert.deepEqual([taken.status, taken.body.customerId], [409, own.customerId]);
  const theirs = ok(await s.o.b.call("POST", `${s.crm}/appointments`, { customerId: own.customerId, staffId: s.p1, serviceIds: [s.s1], start: `${D(3)}T16:00` }), 201).id;

  for (const c of [first, await telegram(s, "999", "mallory_x")]) {
    assert.deepEqual((await c.run("crm_my_bookings")).output.bookings.map((b) => b.booking), [own.id]);
    assert.deepEqual((await c.run("crm_cancel_booking", { booking: theirs })).output, { error: "not_found" });
  }
  // The handle the AI agent saved on that customer vouches for nobody: another account with that handle is not them.
  assert.deepEqual((await (await telegram(s, "1000", "mallory_x")).run("crm_my_bookings")).output, { error: "customer_unknown", missing: ["name", "phone"] });
});

test("a booking whose price or length changed after the card is refused on Confirm", async () => {
  const s = await business();
  const c = await chat(s);
  await c.run("crm_identify_customer", { phone: "+998901112233", name: "Aziza" });
  const priced = await c.run("crm_book", { services: [s.s1], start: `${D(2)}T10:00`, specialist: s.p1 });
  ok(await s.o.b.call("PUT", `${s.crm}/services/${s.s1}`, { price: 250000 }));
  const out = await decideCrmAction(c.cid, priced.card.action_id, true);
  assert.equal(out.status, "failed");
  assert.deepEqual(JSON.parse(out.error).hard, [{ code: "price_changed" }]);

  const longer = await c.run("crm_book", { services: [s.s1], start: `${D(2)}T10:00`, specialist: s.p1 });
  assert.match(longer.card.total, /250 000/);
  ok(await s.o.b.call("PUT", `${s.crm}/services/${s.s1}`, { duration: 180 }));
  assert.deepEqual(JSON.parse((await decideCrmAction(c.cid, longer.card.action_id, true)).error).hard, [{ code: "price_changed" }]);
  assert.equal((await snapshot(s, "appointments")).appointments.length, 0);
});

test("an order whose delivery fee changed after the card is refused on Confirm", async () => {
  const s = await business();
  const c = await chat(s);
  await c.run("crm_identify_customer", { phone: "+998901112233", name: "Aziza" });
  const { card } = await c.run("crm_place_order", { lines: [{ product: s.roses, qty: 1 }], delivery: { method: "courier", address: "Chilonzor 5" } });
  assert.equal(card.total, "Total: 130 000 soʻm");
  const methods = (await snapshot(s, "settings")).deliveryMethods;
  ok(await s.o.b.call("PUT", `${s.crm}/settings`, { deliveryMethods: methods.map((m) => (m.id === "courier" ? { ...m, fee: 90000 } : m)) }));
  const out = await decideCrmAction(c.cid, card.action_id, true);
  assert.equal(out.status, "failed");
  assert.deepEqual(JSON.parse(out.error).hard, [{ code: "price_changed" }]);
  assert.equal((await snapshot(s, "orders")).orders.length, 0);
});

test("a phone typed in chats makes at most the pages' daily share of bookings, and of orders", async () => {
  const s = await business();
  const phone = "+998901234567"; // the team's customer
  const shown = [];
  for (let i = 0; i < 4; i++) {
    const c = await chat(s);
    await c.run("crm_identify_customer", { phone, name: "Someone" });
    shown.push([c, (await c.run("crm_book", { services: [s.s1], start: `${D(2)}T1${i}:00`, specialist: s.p1 })).card]);
  }
  // Four cards were shown before any Confirm: the fourth Confirm is over the cap.
  for (const [c, card] of shown.slice(0, 3)) assert.equal((await decideCrmAction(c.cid, card.action_id, true)).status, "done");
  const over = await decideCrmAction(shown[3][0].cid, shown[3][1].action_id, true);
  assert.deepEqual(JSON.parse(over.error), { error: "phone_limit", max: 3 }, "the same answer as before a card");
  assert.equal((await snapshot(s, "appointments")).appointments.filter((a) => a.customerId === s.team).length, 3);

  // A new chat is told before any card. Orders are counted on their own.
  const c = await chat(s);
  await c.run("crm_identify_customer", { phone, name: "Someone" });
  assert.deepEqual((await c.run("crm_book", { services: [s.s1], start: `${D(2)}T15:00`, specialist: s.p1 })).output, { error: "phone_limit", max: 3 });
  const order = () => c.run("crm_place_order", { lines: [{ product: s.roses, qty: 1 }], delivery: { method: "pickup" } });
  for (let i = 0; i < 3; i++) assert.equal((await decideCrmAction(c.cid, (await order()).card.action_id, true)).status, "done");
  assert.deepEqual((await order()).output, { error: "phone_limit", max: 3 });
});

test("identifying tells a chat nothing about whether a phone belongs to a customer", async () => {
  const s = await business();
  const steps = async (phone) => {
    const c = await chat(s);
    const out = [];
    out.push((await c.run("crm_identify_customer", { phone })).output);
    out.push((await c.run("crm_my_bookings")).output);
    out.push((await c.run("crm_identify_customer", { name: "Someone" })).output);
    out.push((await c.run("crm_my_bookings")).output, (await c.run("crm_my_orders")).output, (await c.run("crm_identify_customer")).output);
    return out;
  };
  const unknown = await steps("+998909999999");
  assert.deepEqual(unknown, [
    { error: "customer_unknown", missing: ["name"] },
    { error: "customer_unknown", missing: ["name"] },
    { customer: "ready" },
    { bookings: [] },
    { orders: [] },
    { customer: "ready" },
  ]);
  assert.deepEqual(await steps("+998901234567"), unknown, "the team's customer's phone answers the same");
});

test("impossible days and times are bad input before any rule or query runs", async () => {
  const s = await business();
  const c = await chat(s);
  await c.run("crm_identify_customer", { phone: "+998901112233", name: "Aziza" });
  const bad = [
    ["crm_book", { services: [s.s1], start: `${D(2)}T10:75` }],
    ["crm_book", { services: [s.s1], start: `${D(2)}T24:00` }],
    ["crm_book", { services: [s.s1], start: "2027-02-31T10:00" }],
    ["crm_move_booking", { booking: s.team, start: "2027-13-01T10:00" }],
    ["crm_free_times", { services: [s.s1], day: "2026-13-45" }],
    ["crm_free_times", { services: [s.s1], day: "2027-02-29" }],
    ["crm_order_options", { day: "2027-04-31" }],
    ["crm_place_order", { lines: [{ product: s.roses, qty: 1 }], delivery: { method: "pickup", day: "2027-00-10", window: "12:00-15:00" } }],
  ];
  for (const [name, args] of bad) assert.equal((await c.run(name, args)).output.error, "bad_input", `${name} ${JSON.stringify(args)}`);
  assert.equal((await c.run("crm_free_times", { services: [s.s1], day: "2028-02-29" })).output.error, undefined, "a real 29 February is a day");
});

test("a newer card for the same change takes the older one's place: only the newest can be confirmed", async () => {
  const s = await business();
  const c = await chat(s);
  await c.run("crm_identify_customer", { phone: "+998901112233", name: "Aziza" });
  const first = await c.tool("crm_place_order", { lines: [{ product: s.roses, qty: 1 }], delivery: { method: "pickup" } });
  const second = await c.tool("crm_place_order", { lines: [{ product: s.roses, qty: 2 }], delivery: { method: "pickup" } });
  const cards = async () => (await query("SELECT card FROM messages WHERE conversation_id = $1 AND card->>'type' = 'confirm' ORDER BY seq", [c.cid])).rows.map((r) => [r.card.action_id, r.card.status]);
  assert.deepEqual(await cards(), [[first.card.action_id, "cancelled"], [second.card.action_id, "pending"]]);
  ok(await c.decide(second.card.action_id));
  ok(await c.decide(first.card.action_id), 409);
  assert.deepEqual((await snapshot(s, "orders")).orders.map((o) => o.lines.map((l) => l.qty)), [[2]]);

  // Changes to two bookings are two changes; a second change to one booking replaces the first.
  for (const h of ["10", "11"]) ok(await c.decide((await c.run("crm_book", { services: [s.s1], start: `${D(2)}T${h}:00`, specialist: s.p1 })).card.action_id));
  const [a, b] = (await snapshot(s, "appointments")).appointments.map((x) => x.id);
  const moveA = (await c.run("crm_move_booking", { booking: a, start: `${D(2)}T14:00` })).card;
  const cancelB = (await c.run("crm_cancel_booking", { booking: b })).card;
  const cancelA = (await c.run("crm_cancel_booking", { booking: a })).card;
  const status = async (id) => (await query("SELECT status FROM pending_actions WHERE id = $1", [id])).rows[0].status;
  assert.deepEqual([await status(moveA.action_id), await status(cancelB.action_id), await status(cancelA.action_id)], ["cancelled", "pending", "pending"]);
});

test("a customer the team saved as t.me/handle is known in that Telegram chat", async () => {
  const s = await business();
  ok(await s.o.b.call("PUT", `${s.crm}/customers/${s.team}`, { telegram: "t.me/jasur_k" }));
  assert.deepEqual((await (await telegram(s, "777", "jasur_k")).run("crm_identify_customer")).output, { customer: "known", name: "Jasur Karimov" });
  // A handle saved before the rule, as it was typed, is found too once the migration has run.
  const other = (await s.post("/customers", { name: "Old Record" })).id;
  await query("UPDATE crm_customers SET telegram = 'https://t.me/Old_Rec' WHERE id = $1", [other]);
  await query(fs.readFileSync(new URL("../sql/crm/00-core.sql", import.meta.url), "utf-8"));
  assert.deepEqual((await (await telegram(s, "778", "old_rec")).run("crm_identify_customer")).output, { customer: "known", name: "Old Record" });
});

test("what is left is one answer for the shop page and the chat: a waiting page order holds the last item from the agent", async () => {
  const s = await business();
  ok(await s.o.b.call("PUT", `${s.crm}/settings`, { settings: { publicPage: { slug: `gulzor-${process.pid}`, booking: false, shop: true, description: "", phone: "", address: "", languages: ["uz"], paymentMethods: ["cash"], deliveryMethods: ["pickup"] } } }));
  const variant = (await snapshot(s, "products")).products.find((p) => p.id === s.roses).variants[0].id;
  // A customer on the shop page orders four of the five roses; the team hasn't accepted it yet.
  const page = await browser().call("POST", `/public/crm/gulzor-${process.pid}/orders`, { lines: [{ productId: s.roses, variantId: variant, qty: 4 }], name: "Madina", phone: "+998 93 444 55 66", delivery: { method: "pickup", date: D(2), window: { from: "12:00", to: "15:00" } }, payment: "cash" });
  ok(page, 201);
  const c = await chat(s);
  assert.deepEqual((await c.run("crm_find_products", { search: "roses" })).output.products[0].variants.map((v) => v.left), [1]);
  await c.run("crm_identify_customer", { phone: "+998901112233", name: "Aziza" });
  const { card } = await c.run("crm_place_order", { lines: [{ product: s.roses, qty: 1 }], delivery: { method: "pickup" } });
  assert.deepEqual((await c.run("crm_place_order", { lines: [{ product: s.roses, qty: 2 }], delivery: { method: "pickup" } })).output, { error: "short", product: s.roses, variant, left: 1 });
  // The order this chat makes holds its item from the page in turn.
  assert.equal((await decideCrmAction(c.cid, card.action_id, true)).status, "done");
  const shop = ok(await browser().call("GET", `/public/crm/gulzor-${process.pid}/products`)).products.find((p) => p.id === s.roses);
  assert.deepEqual([shop.variants[0].available, shop.variants[0].left], [false, 0]);
  assert.deepEqual((await c.run("crm_find_products", { search: "roses" })).output, { found: 0, products: [] });
});

test("search runs in the database: every word must match the name, an option, a SKU or the category, one page at a time", async () => {
  const s = await business();
  ok(await s.o.b.call("PUT", `${s.crm}/settings`, { productCategories: [{ id: "fl", name: { en: "Flowers", ru: "Цветы", uz: "Gullar" } }] }));
  for (let i = 0; i < 10; i++) await s.post("/products", { name: `Tulip ${i}`, category: "fl", sku: `TU-${i}`, price: 1000, opening: 1 });
  await s.post("/products", { name: "Vase", options: [{ id: "c", name: "Colour", values: ["Blue", "Green_1"] }], variants: [{ values: { c: "Blue" }, price: 5000, opening: 1 }, { values: { c: "Green_1" }, price: 5000, opening: 1 }] });
  const c = await chat(s);
  const find = async (search) => (await c.run("crm_find_products", { search })).output;
  const tulips = await find("tulip");
  assert.deepEqual([tulips.found, tulips.products.length, tulips.products[0].name], [10, 8, "Tulip 9"], "the newest first, eight shown, all counted");
  assert.deepEqual((await find("цветы TU-3")).products.map((p) => p.name), ["Tulip 3"], "a category's name in any language and a SKU");
  assert.deepEqual((await find("blue")).products.map((p) => p.name), ["Vase"]);
  assert.equal((await find("green_1")).found, 1, "an option value with a LIKE wildcard in it");
  assert.equal((await find("green%")).found, 0);
  assert.equal((await find("tulip vase")).found, 0, "every word must match");
});

test("an order in a chat asks for at most what the shop page may show is left, so nobody learns or holds the whole shelf", async () => {
  const s = await business();
  const many = (await s.post("/products", { name: "Tulips", price: 1000, opening: 37 })).id;
  const variant = (await snapshot(s, "products")).products.find((p) => p.id === many).variants[0].id;
  const c = await chat(s);
  await c.run("crm_identify_customer", { phone: "+998901112233", name: "Aziza" });
  const place = (lines) => c.run("crm_place_order", { lines, delivery: { method: "pickup" } }).then((r) => r.output);
  // More than 10 on one line is not an input the tool takes; split over lines it is refused before the stock is asked.
  assert.equal((await place([{ product: many, qty: 11 }])).error, "bad_input");
  assert.equal((await place([{ product: many, qty: 37 }])).error, "bad_input");
  assert.deepEqual(await place([{ product: many, qty: 6 }, { product: many, qty: 6 }]), { error: "too_many", product: many, variant, max: 10 });
  const tool = (await crmTools(s.row)).find((t) => t.tool.name === "crm_place_order").tool;
  assert.equal(tool.input.properties.lines.items.properties.qty.maximum, 10);
  // Ten is fine, and that order holds ten, not the shelf.
  assert.equal((await decideCrmAction(c.cid, (await c.run("crm_place_order", { lines: [{ product: many, qty: 10 }], delivery: { method: "pickup" } })).card.action_id, true)).status, "done");
  assert.deepEqual((await c.run("crm_find_products", { search: "tulips" })).output.products[0].variants.map((v) => v.left), [10]);
});

test("a Telegram handle the team takes off a customer, or moves to another, takes that account's access with it", async () => {
  const s = await business();
  ok(await s.o.b.call("PUT", `${s.crm}/customers/${s.team}`, { telegram: "@stranger" }));
  const jasurs = ok(await s.o.b.call("POST", `${s.crm}/appointments`, { customerId: s.team, staffId: s.p1, serviceIds: [s.s1], start: `${D(2)}T09:00` }), 201).id;
  const old = await telegram(s, "4242", "stranger");
  assert.deepEqual((await old.run("crm_identify_customer")).output, { customer: "known", name: "Jasur Karimov" });
  assert.deepEqual((await old.run("crm_my_bookings")).output.bookings.map((b) => b.booking), [jasurs]);
  const waiting = await old.run("crm_cancel_booking", { booking: jasurs });
  assert.ok(waiting.card);

  // The team clears the handle: neither the old chat nor a new one of that account is Jasur any more.
  ok(await s.o.b.call("PUT", `${s.crm}/customers/${s.team}`, { telegram: "" }));
  for (const c of [old, await telegram(s, "4242", "stranger")]) {
    assert.deepEqual((await c.run("crm_my_bookings")).output, { error: "customer_unknown", missing: ["name", "phone"] });
    // Like any chat nobody vouches for, it is asked for the phone (the name comes from Telegram).
    assert.deepEqual((await c.run("crm_identify_customer")).output, { error: "customer_unknown", missing: ["phone"] });
  }
  // A card made while the handle was his can't be confirmed now.
  const out = await old.decide(waiting.card.action_id);
  assert.deepEqual([out.status, JSON.parse(out.error)], ["failed", { error: "customer_unknown", missing: ["phone"] }]);
  assert.equal((await snapshot(s, "appointments")).appointments.find((a) => a.id === jasurs).status, "confirmed");

  // The handle saved on another customer: the account is that customer now, and sees nothing of Jasur's.
  const other = (await s.post("/customers", { name: "Olim Tursunov", phone: "+998935554433", telegram: "stranger" })).id;
  const olims = ok(await s.o.b.call("POST", `${s.crm}/appointments`, { customerId: other, staffId: s.p2, serviceIds: [s.s1], start: `${D(3)}T09:00` }), 201).id;
  assert.deepEqual((await old.run("crm_identify_customer")).output, { customer: "known", name: "Olim Tursunov" });
  assert.deepEqual((await old.run("crm_my_bookings")).output.bookings.map((b) => b.booking), [olims]);
  assert.deepEqual((await old.run("crm_cancel_booking", { booking: jasurs })).output, { error: "not_found" });
});

test("a move or cancel refused on Confirm because the booking can't be changed any more offers the team, never other times", async () => {
  const s = await business();
  const c = await chat(s);
  await c.run("crm_identify_customer", { phone: "+998901112233", name: "Aziza" });
  ok(await c.decide((await c.run("crm_book", { services: [s.s1], start: `${D(1)}T12:00`, specialist: s.p1 })).card.action_id));
  const [a] = (await snapshot(s, "appointments")).appointments;
  const outcome = async (card) => JSON.parse((await decideCrmAction(c.cid, card.action_id, true)).error);
  const { settings } = await snapshot(s, "settings");
  const cancelUntil = (minutes) => s.o.b.call("PUT", `${s.crm}/settings`, { settings: { rules: { ...settings.rules, cancelUntil: minutes } } });

  // The business now takes changes only two days ahead: the card answers as the tools do before a card.
  for (const card of [() => c.run("crm_move_booking", { booking: a.id, start: `${D(1)}T13:00` }), () => c.run("crm_cancel_booking", { booking: a.id })]) {
    const { card: waiting } = await card();
    ok(await cancelUntil(2880));
    assert.deepEqual(await outcome(waiting), { error: "cancel_closed", minutes: 2880, handoff: true });
    ok(await cancelUntil(settings.rules.cancelUntil));
  }

  // The team cancelled it meanwhile.
  const again = (await c.run("crm_move_booking", { booking: a.id, start: `${D(1)}T14:00` })).card;
  ok(await s.o.b.call("POST", `${s.crm}/appointments/${a.id}/step`, { status: "cancelled" }));
  assert.deepEqual(await outcome(again), { error: "booking_closed", handoff: true });
  assert.equal((await snapshot(s, "appointments")).appointments.find((x) => x.id === a.id).start, `${D(1)}T12:00`);

  // The team deleted it meanwhile: simply not found.
  ok(await c.decide((await c.run("crm_book", { services: [s.s1], start: `${D(2)}T12:00`, specialist: s.p1 })).card.action_id));
  const b = (await snapshot(s, "appointments")).appointments.find((x) => x.start === `${D(2)}T12:00`);
  const late = (await c.run("crm_move_booking", { booking: b.id, start: `${D(2)}T13:00` })).card;
  ok(await s.o.b.call("DELETE", `${s.crm}/appointments/${b.id}`));
  assert.deepEqual(await outcome(late), { error: "not_found" });
});
