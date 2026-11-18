// Messages from the CRM to a customer: what each write queues (booked, moved, cancelled, the
// reminder, order steps, an order cancelled), the switches and texts in settings, the reminder's
// time on the business's clock, sending in the jobs worker (one send per message even with two
// workers, retries with backoff), the Telegram channel, tenancy and roles.
// Customers are reached through a fake SMS provider registered the way a real one would be.
import assert from "node:assert/strict";
import http from "node:http";
import { beforeEach, test } from "node:test";
import { crmOwner, owner, teammate, browser, base, query, drainJobs } from "./helpers/setup.js";
import { runCrmTool, decideCrmAction } from "../src/bridge/crm-tools.js";
import "../src/agent/channels/notice-sender.js";
import { registerSender } from "../src/core/senders.js";
import { nowIn, addDays, dayOf } from "../src/crm/shared/time.js";
import { NOTICE_TEXTS, NOTICE_LANGUAGES, render, dayText, moneyText, noticeSettings, unknownPlaceholders, strayBraces, nameIn } from "../src/crm/shared/notices.js";
import { bookingNotice, formerNotice, orderNotice, onePerCustomer, staleReason } from "../src/crm/notices/decide.js";
import { extendAll } from "../src/crm/booking/series-job.js";
import { onChanges } from "../src/crm/notices/queue.js";
import { sendDue, claimDue, MAX_TRIES, BACKOFF } from "../src/crm/notices/send.js";

const today = () => dayOf(nowIn("Asia/Tashkent", new Date()));
const D = (n) => addDays(today(), n);
const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, ["00:00", "24:00"]]));
const HAIRCUT = { en: "Haircut", ru: "Стрижка", uz: "Soch olish" };
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * An SMS provider stand-in: reaches every customer with a phone, records what it "sent", answers as told.
 * Like a real provider it reads the database to answer reach(); it also notes when it was asked while
 * a report held its workspace's lock (a report must ask before it takes the lock).
 */
const sms = {
  sent: [],
  answers: [],
  delay: 0,
  lockedReach: 0,
  async reach(workspaceId, people) {
    const { rows } = await query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS free", [`crm_notices:${workspaceId}`]);
    if (!rows[0].free) this.lockedReach++;
    return Object.fromEntries(people.filter((p) => p.phone).map((p) => [p.id, { address: p.phone }]));
  },
  async send(address, text) {
    if (this.delay) await sleep(this.delay);
    this.sent.push({ address, text });
    return this.answers.shift() || { ok: true };
  },
};
registerSender("sms", sms);
const resetSms = () => Object.assign(sms, { sent: [], answers: [], delay: 0, lockedReach: 0 });
const NETWORK = { ok: false, code: "network", retry: true };

// The sender works across workspaces: what an earlier test left waiting must not be sent in this one.
beforeEach(async () => {
  resetSms();
  await query("UPDATE crm_notices SET status = 'skipped', reason = 'test' WHERE status = 'queued'");
});

/** A CRM workspace with a service, a specialist working around the clock, and two customers (one has no phone). */
async function shop(o = null) {
  o ||= await crmOwner();
  const post = (path, body, status = 201) => o.b.call("POST", o.crm + path, body).then((r) => ok(r, status));
  const s1 = (await post("/services", { name: HAIRCUT, duration: 30, price: 50000 })).id;
  const p1 = (await post("/staff", { name: "Aziz", hours: ALL_DAY, serviceIds: [s1] })).id;
  const p2 = (await post("/staff", { name: "Bek", hours: ALL_DAY, serviceIds: [s1] })).id;
  const c1 = (await post("/customers", { name: "Jasur Karimov", phone: "+998901234567" })).id;
  const c2 = (await post("/customers", { name: "Malika Aliyeva" })).id;
  const book = (start, body = {}, b = o.b) => b.call("POST", `${o.crm}/appointments`, { customerId: c1, staffId: p1, serviceIds: [s1], start, ...body }).then((r) => ok(r, 201));
  const settings = (s) => o.b.call("PUT", `${o.crm}/settings`, { settings: s }).then((r) => ok(r));
  const list = (qs = "", b = o.b) => b.call("GET", `${o.crm}/notices${qs}`).then((r) => ok(r).notices);
  const about = async (id) => (await list(`?itemId=${id}`)).reverse();
  return { ...o, s1, p1, p2, c1, c2, post, book, settings, list, about };
}

/** Makes every waiting message due now (tests can't wait two hours for a reminder). */
const dueNow = (id) => query("UPDATE crm_notices SET send_at = now() WHERE id = $1", [id]);
const row = async (id) => (await query("SELECT * FROM crm_notices WHERE id = $1", [id])).rows[0];
const at = (moment, offset) => new Date(`${moment}:00${offset}`).getTime();

/* ───── Pure rules ───── */

test("texts: defaults in three languages, placeholders filled, days and sums in the customer's words", () => {
  for (const [kind, texts] of Object.entries(NOTICE_TEXTS)) {
    for (const l of NOTICE_LANGUAGES) {
      assert.ok(texts[l], `${kind} has ${l}`);
      assert.doesNotMatch(texts[l], /[—!]|[\u{1F300}-\u{1FAFF}]/u, `${kind}.${l} has no em dash, exclamation mark or emoji`);
      assert.deepEqual(unknownPlaceholders(kind, texts[l]), [], `${kind}.${l} uses only its own placeholders`);
    }
    assert.doesNotMatch(texts.uz, /[ʼ'‘]/, `${kind}.uz writes oʻ and gʻ with U+02BB`);
  }
  assert.equal(render("Hi, {name}. {nope}", { name: "Aziz" }), "Hi, Aziz.");
  assert.equal(dayText("2026-11-19", "en"), "Thursday, 19 November");
  assert.equal(dayText("2026-11-19", "ru"), "четверг, 19 ноября");
  assert.equal(dayText("2026-11-19", "uz"), "19-noyabr, payshanba");
  assert.equal(moneyText(1250000, "en"), "1 250 000 soʻm");
  assert.equal(moneyText(1250000, "ru"), "1 250 000 сум");
  assert.equal(nameIn(HAIRCUT, "ru"), "Стрижка");
  assert.deepEqual(unknownPlaceholders("booked", "{name} {number} {total}"), ["number", "total"]);

  const filled = noticeSettings({ remindOn: false, notices: { language: "ru", booked: { on: false, text: { en: "Booked, {name}.", ru: "" } }, orderStep: { steps: ["packing"] } } });
  assert.equal(filled.language, "ru");
  assert.deepEqual(filled.booked, { on: false, text: { en: "Booked, {name}.", ru: NOTICE_TEXTS.booked.ru, uz: NOTICE_TEXTS.booked.uz } }, "an empty text is the default one");
  assert.equal(filled.reminder.on, false, "the reminder follows settings.remindOn");
  assert.equal(filled.moved.on, true, "a switch left out is on");
  assert.deepEqual(filled.orderStep.steps, ["packing"]);
  assert.equal(noticeSettings({}).language, "uz");
});

test("decisions: by the step's kind, from how the item was to how it is", () => {
  const s = (kind, start = "2026-11-19T10:00", staffId = "p1") => ({ status: `x-${kind}`, kind, start, staffId });
  assert.equal(bookingNotice(null, s("booked")), "booked", "made confirmed");
  assert.equal(bookingNotice(null, s("pending")), null, "waiting for someone to confirm it");
  assert.equal(bookingNotice(s("pending"), s("booked")), "booked", "confirmed");
  assert.equal(bookingNotice(s("cancelled"), s("booked")), "booked", "brought back");
  assert.equal(bookingNotice(s("booked"), s("booked", "2026-11-19T11:00")), "moved");
  assert.equal(bookingNotice(s("booked"), s("booked", "2026-11-19T10:00", "p2")), "moved", "another specialist");
  assert.equal(bookingNotice(s("booked"), s("booked")), null, "nothing the customer cares about changed");
  assert.equal(bookingNotice(s("here"), s("booked")), null);
  assert.equal(bookingNotice(s("booked"), s("cancelled")), "cancelled");
  assert.equal(bookingNotice(s("pending"), s("cancelled")), "cancelled");
  assert.equal(bookingNotice(s("noshow"), s("cancelled")), null);
  assert.equal(bookingNotice(null, s("booked"), { seriesId: "r1" }), null, "a repeat booking's new visit");
  const of = (kind, customerId) => ({ ...s(kind), customerId });
  assert.equal(bookingNotice(of("booked", "c1"), of("booked", "c2")), "booked", "given to another customer: the new one is told");
  assert.equal(formerNotice(of("booked", "c1"), of("booked", "c2")), "cancelled", "and the old one hears it is no longer theirs");
  assert.equal(formerNotice(of("pending", "c1"), of("booked", "c2")), "cancelled");
  assert.equal(formerNotice(of("done", "c1"), of("done", "c2")), null, "a past visit corrected says nothing");
  assert.equal(formerNotice(of("booked", "c1"), of("booked", "c1")), null);
  assert.equal(bookingNotice(s("booked"), of("booked", "c2")), null, "a state kept before customers were remembered is no hand-over");

  // A message is checked against the item as the last write left it before it goes.
  assert.equal(staleReason(of("booked", "c1"), of("booked", "c1")), null);
  assert.equal(staleReason(of("booked", "c1"), { ...of("booked", "c1"), start: "2026-11-19T11:00" }), "item_changed");
  assert.equal(staleReason(of("booked", "c1"), of("cancelled", "c1")), "item_changed");
  assert.equal(staleReason(of("booked", "c1"), null), "item_gone");
  assert.equal(staleReason(null, of("cancelled", "c1")), null, "a message queued before states were kept is not checked");

  const o = (status, kind) => ({ status, kind });
  assert.equal(orderNotice(null, o("new", "open"), ["new"]), "orderStep", "a new order in a ticked step");
  assert.equal(orderNotice(null, o("new", "open"), []), null);
  assert.equal(orderNotice(o("new", "open"), o("packing", "reserved"), ["packing"]), "orderStep");
  assert.equal(orderNotice(o("packing", "reserved"), o("packing", "reserved"), ["packing"]), null, "an edit that keeps the step");
  assert.equal(orderNotice(o("new", "open"), o("cancelled", "cancelled"), []), "orderCancelled");

  const says = onePerCustomer([
    { customerId: "c1", kind: "moved", order: "2026-11-26T10:00", id: 2 },
    { customerId: "c1", kind: "moved", order: "2026-11-19T10:00", id: 1 },
    { customerId: "c2", kind: "moved", order: "2026-11-30T10:00", id: 3 },
  ]);
  assert.deepEqual(says.map((x) => x.id).sort(), [1, 3], "one message per customer and kind, about the earliest item");
});

/* ───── Bookings ───── */

test("booking: confirmed, moved and cancelled each queue exactly one message, in each language", async () => {
  const o = await shop();
  const expect = {
    booked: (l, day, time) => render(NOTICE_TEXTS.booked[l], { name: "Jasur Karimov", service: HAIRCUT[l], day: dayText(day, l), time }),
    moved: (l, day, time) => render(NOTICE_TEXTS.moved[l], { name: "Jasur Karimov", service: HAIRCUT[l], day: dayText(day, l), time }),
    cancelled: (l, day, time) => render(NOTICE_TEXTS.cancelled[l], { name: "Jasur Karimov", service: HAIRCUT[l], day: dayText(day, l), time }),
  };
  for (const [i, l] of NOTICE_LANGUAGES.entries()) {
    await o.settings({ notices: { language: l } });
    const hour = String(10 + i * 3).padStart(2, "0");
    const made = await o.book(`${D(3)}T${hour}:00`);
    let ns = await o.about(made.id);
    assert.deepEqual(ns.map((n) => [n.kind, n.status]), [["booked", "queued"], ["reminder", "queued"]], l);
    assert.equal(ns[0].text, expect.booked(l, D(3), `${hour}:00`));
    assert.equal(ns[0].language, l);
    assert.equal(ns[0].channel, "sms");
    assert.deepEqual(ns[0].item, { key: "appointments", id: made.id });
    assert.equal(ns[0].customerId, o.c1);

    ok(await o.b.call("POST", `${o.crm}/appointments/${made.id}/move`, { start: `${D(4)}T${hour}:30` }));
    ns = await o.about(made.id);
    assert.deepEqual(ns.map((n) => [n.kind, n.status, n.reason]), [["booked", "skipped", "superseded"], ["reminder", "queued", null], ["moved", "queued", null]], l);
    assert.equal(ns[2].text, expect.moved(l, D(4), `${hour}:30`));
    assert.match(ns[1].text, new RegExp(`${hour}:30`), "the reminder is written again for the new time");

    // An edit that changes nothing the customer cares about says nothing.
    ok(await o.b.call("PUT", `${o.crm}/appointments/${made.id}`, { note: "Window seat" }));
    assert.equal((await o.about(made.id)).length, 3);

    ok(await o.b.call("POST", `${o.crm}/appointments/${made.id}/step`, { status: "cancelled" }));
    ns = await o.about(made.id);
    assert.deepEqual(ns.map((n) => [n.kind, n.status, n.reason]), [["booked", "skipped", "superseded"], ["reminder", "skipped", "item_closed"], ["moved", "skipped", "superseded"], ["cancelled", "queued", null]], l);
    assert.equal(ns[3].text, expect.cancelled(l, D(4), `${hour}:30`));
  }
  // What was queued goes out through the jobs worker.
  resetSms();
  await drainJobs();
  assert.equal(sms.sent.length, 3, "the three cancellations");
  assert.ok(sms.sent.every((s) => s.address === "+998901234567"));
  assert.ok((await o.list()).filter((n) => n.kind === "cancelled").every((n) => n.status === "sent" && n.sentAt));
});

test("booking: a customer nobody can reach gets a skipped record with a reason, a waiting booking says nothing", async () => {
  const o = await shop();
  const made = await o.book(`${D(2)}T10:00`, { customerId: o.c2 });
  const ns = await o.about(made.id);
  assert.deepEqual(ns.map((n) => [n.kind, n.channel, n.status, n.reason]), [["booked", "none", "skipped", "no_channel"], ["reminder", "none", "queued", null]]);
  await dueNow(ns[1].id);
  assert.equal((await sendDue()).skipped, 1);
  assert.deepEqual([(await row(ns[1].id)).status, (await row(ns[1].id)).reason, (await row(ns[1].id)).tries], ["skipped", "no_channel", 0]);

  // A booking that waits for someone to confirm it (the first step is pending) says nothing until confirmed.
  const pending = await o.book(`${D(2)}T12:00`, { staffId: o.p2 });
  ok(await o.b.call("POST", `${o.crm}/appointments/${pending.id}/step`, { status: "new" }));
  const before = (await o.about(pending.id)).map((n) => [n.kind, n.status, n.reason]);
  assert.deepEqual(before, [["booked", "queued", null], ["reminder", "skipped", "item_closed"]]);
  ok(await o.b.call("POST", `${o.crm}/appointments/${pending.id}/step`, { status: "confirmed" }));
  const after = await o.about(pending.id);
  assert.deepEqual(after.map((n) => n.kind), ["booked", "reminder", "booked", "reminder"], "confirmed again: told again, and a new reminder");
});

test("switches off: nothing is queued", async () => {
  const o = await shop();
  await o.settings({ remindOn: false, notices: { booked: { on: false }, moved: { on: false }, cancelled: { on: false }, orderStep: { on: false, steps: ["new", "confirmed"] }, orderCancelled: { on: false } } });
  const made = await o.book(`${D(2)}T10:00`);
  ok(await o.b.call("POST", `${o.crm}/appointments/${made.id}/move`, { start: `${D(2)}T11:00` }));
  ok(await o.b.call("POST", `${o.crm}/appointments/${made.id}/step`, { status: "cancelled" }));
  const product = (await o.post("/products", { name: "Vase", price: 120000, opening: 5 })).id;
  const order = (await o.post("/orders", { customerId: o.c1, lines: [{ productId: product, qty: 1 }], delivery: { type: "pickup" } })).id;
  ok(await o.b.call("POST", `${o.crm}/orders/${order}/step`, { to: "confirmed" }));
  ok(await o.b.call("POST", `${o.crm}/orders/${order}/cancel`, {}));
  assert.deepEqual(await o.list(), []);

  // Turned off later: what was waiting is dropped, and what was already claimed stays unsent.
  await o.settings({ remindOn: true, notices: {} });
  const next = await o.book(`${D(3)}T10:00`);
  const [booked, reminder] = await o.about(next.id);
  await o.settings({ remindOn: false, notices: { booked: { on: false } } });
  assert.deepEqual([(await row(booked.id)).reason, (await row(reminder.id)).reason], ["switched_off", "switched_off"]);
});

test("settings: texts are saved with CRM settings and used; unknown placeholders are refused", async () => {
  const o = await shop();
  const saved = await o.settings({ notices: { language: "en", booked: { text: { en: "See you {day} at {time}, {name}. {business}" } }, orderStep: { steps: ["confirmed", "confirmed"] } } });
  assert.deepEqual(saved.changes.top.settings.notices.orderStep, { steps: ["confirmed"] });
  const snap = ok(await o.b.call("GET", `${o.crm}/snapshot?only=settings`));
  assert.equal(snap.settings.notices.booked.text.en, "See you {day} at {time}, {name}. {business}");
  const made = await o.book(`${D(2)}T09:15`);
  assert.equal((await o.about(made.id))[0].text, `See you ${dayText(D(2), "en")} at 09:15, Jasur Karimov. Guldasta`);

  const bad = await o.b.call("PUT", `${o.crm}/settings`, { settings: { notices: { moved: { text: { ru: "Заказ №{number}" } } } } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.issues[0].message, "unknown_placeholder");
  assert.deepEqual(bad.body.issues[0].params, { placeholder: "number" });
  assert.equal((await o.b.call("PUT", `${o.crm}/settings`, { settings: { notices: { booked: { loud: true } } } })).status, 400);

  // A brace that isn't a whole placeholder would reach the customer as it is: refused.
  for (const text of ["Hi { name }, see you {day}", "Hi {name_1}", "Hi {{name}}", "Hi {name", "Hi name}", "Hi {}"]) {
    const r = await o.b.call("PUT", `${o.crm}/settings`, { settings: { notices: { booked: { text: { en: text } } } } });
    assert.equal(r.status, 400, text);
    assert.equal(r.body.issues[0].message, "bad_placeholder", text);
  }
  assert.equal(strayBraces("Hi {name}, {day} at {time}"), false);
  assert.equal(strayBraces("Hi {{name}}"), true);
});

/* ───── The reminder's time ───── */

test("reminder: remindBefore minutes before the start, on the business's clock, across midnight and time zones", async () => {
  const o = await shop();
  await o.settings({ remindBefore: 120 });
  const made = await o.book(`${D(3)}T00:30`);
  const [, reminder] = await o.about(made.id);
  assert.equal(reminder.sendAt, `${D(2)}T22:30`, "two hours before half past midnight is the evening before");
  assert.equal(new Date((await row(reminder.id)).send_at).getTime(), at(`${D(2)}T22:30`, "+05:00"), "Tashkent's clock is UTC+5");

  // The business's clock moves to another zone: the next write times the reminder on it.
  await query("UPDATE crm_settings SET timezone = 'Asia/Kolkata' WHERE workspace_id = $1", [o.ws.id]);
  ok(await o.b.call("POST", `${o.crm}/appointments/${made.id}/move`, { start: `${D(3)}T01:15` }));
  const moved = await row(reminder.id);
  assert.equal(moved.status, "queued", "re-timed in place, not a second reminder");
  assert.equal(new Date(moved.send_at).getTime(), at(`${D(2)}T23:15`, "+05:30"));
  assert.equal(new Date(moved.item_at).getTime(), at(`${D(3)}T01:15`, "+05:30"));
  assert.equal((await query("SELECT count(*)::int AS n FROM crm_notices WHERE item_id = $1 AND kind = 'reminder'", [made.id])).rows[0].n, 1);

  // A new remindBefore re-times what waits.
  await o.settings({ remindBefore: 1440 });
  assert.equal(new Date((await row(reminder.id)).send_at).getTime(), at(`${D(2)}T01:15`, "+05:30"));

  // A visit too close for its reminder gets none.
  await o.settings({ remindBefore: 43200 });
  const soon = await o.book(`${D(1)}T10:00`, { staffId: o.p2 });
  assert.deepEqual((await o.about(soon.id)).map((n) => n.kind), ["booked"]);
  // The same rule for one that waits: a new gap that puts its moment in the past drops it, never sends it at once.
  assert.deepEqual([(await row(reminder.id)).status, (await row(reminder.id)).reason], ["skipped", "too_late"]);
});

test("reminder: a new time zone saved in settings re-times what waits on the new clock", async () => {
  const o = await shop();
  await o.settings({ remindBefore: 60 });
  const made = await o.book(`${D(3)}T10:00`);
  const [, reminder] = await o.about(made.id);
  assert.equal(new Date((await row(reminder.id)).send_at).getTime(), at(`${D(3)}T09:00`, "+05:00"));
  await o.settings({ timezone: "Asia/Kolkata" });
  const after = await row(reminder.id);
  assert.equal(after.status, "queued");
  assert.equal(new Date(after.item_at).getTime(), at(`${D(3)}T10:00`, "+05:30"), "the visit is at ten on the new clock");
  assert.equal(new Date(after.send_at).getTime(), at(`${D(3)}T09:00`, "+05:30"));
  assert.equal((await o.about(made.id)).find((n) => n.id === reminder.id).sendAt, `${D(3)}T09:00`);
});

test("reminder: a settings save or an edit never cuts short the wait of a reminder that failed a try", async () => {
  const o = await shop();
  await o.settings({ remindBefore: 60, notices: { booked: { on: false } } });
  const made = await o.book(`${D(3)}T10:00`);
  const [r] = await o.about(made.id);
  await dueNow(r.id);
  sms.answers.push(NETWORK);
  await sendDue();
  const waiting = await row(r.id);
  assert.deepEqual([waiting.status, waiting.tries], ["queued", 1]);
  await o.settings({ remindBefore: 90 });
  assert.equal(new Date((await row(r.id)).send_at).getTime(), new Date(waiting.send_at).getTime(), "a new remindBefore leaves the retry's time");
  ok(await o.b.call("PUT", `${o.crm}/appointments/${made.id}`, { note: "Window seat" }));
  assert.equal(new Date((await row(r.id)).send_at).getTime(), new Date(waiting.send_at).getTime(), "an edit leaves it too");
  // A move is news: the reminder is written and timed again for the new start.
  ok(await o.b.call("POST", `${o.crm}/appointments/${made.id}/move`, { start: `${D(3)}T12:00` }));
  assert.equal(new Date((await row(r.id)).send_at).getTime(), at(`${D(3)}T10:30`, "+05:00"));
});

test("reminder: moved or cancelled meanwhile is re-timed or dropped, deleted is dropped, never sent wrong", async () => {
  const o = await shop();
  await o.settings({ notices: { booked: { on: false } } });
  const made = await o.book(`${D(2)}T10:00`);
  const reminderOf = async (id) => (await o.about(id)).filter((n) => n.kind === "reminder");

  // Sent when due, with the visit's real time.
  let [r] = await reminderOf(made.id);
  resetSms();
  await dueNow(r.id);
  await sendDue();
  assert.equal((await row(r.id)).status, "sent");
  assert.deepEqual(sms.sent.map((s) => s.text), [render(NOTICE_TEXTS.reminder.uz, { name: "Jasur Karimov", service: HAIRCUT.uz, day: dayText(D(2), "uz"), time: "10:00" })]);

  // A report that never arrived (a crash after the commit): the stored state says the visit moved, so the old reminder is skipped.
  const other = await o.book(`${D(2)}T12:00`);
  [r] = await reminderOf(other.id);
  await query("UPDATE crm_notice_items SET state = jsonb_set(state, '{start}', to_jsonb($2::text)) WHERE item_id = $1", [other.id, `${D(2)}T13:00`]);
  await dueNow(r.id);
  resetSms();
  await sendDue();
  assert.deepEqual([(await row(r.id)).status, (await row(r.id)).reason, sms.sent.length], ["skipped", "item_changed", 0]);

  // A visit whose start has passed: too late.
  const third = await o.book(`${D(2)}T14:00`);
  [r] = await reminderOf(third.id);
  await query("UPDATE crm_notices SET send_at = now(), item_at = now() - interval '1 minute' WHERE id = $1", [r.id]);
  await sendDue();
  assert.equal((await row(r.id)).reason, "too_late");

  // Deleted: everything waiting about it is dropped.
  const fourth = await o.book(`${D(2)}T16:00`);
  [r] = await reminderOf(fourth.id);
  ok(await o.b.call("DELETE", `${o.crm}/appointments/${fourth.id}`));
  assert.deepEqual([(await row(r.id)).status, (await row(r.id)).reason], ["skipped", "item_gone"]);

  // Reports that arrive out of order: an older one never takes back a newer one.
  const fifth = await o.book(`${D(2)}T18:00`);
  const moved = ok(await o.b.call("POST", `${o.crm}/appointments/${fifth.id}/move`, { start: `${D(2)}T19:00` }));
  const first = (await o.b.call("GET", `${o.crm}/snapshot?only=appointments`)).body.appointments.find((a) => a.id === fifth.id);
  const stale = { ...first, start: `${D(2)}T18:00` };
  await onChanges({ workspaceId: o.ws.id, cfg: { workspaceId: o.ws.id, rev: moved.rev - 1 } }, { set: { appointments: [stale] } });
  [r] = await reminderOf(fifth.id);
  assert.equal(r.status, "queued");
  assert.match(r.text, /19:00/);
  assert.deepEqual((await o.about(fifth.id)).map((n) => n.kind), ["reminder", "moved"]);
});

test("repeat bookings: new visits say nothing but get reminders; stopping them sends one message", async () => {
  const o = await shop();
  const first = await o.book(`${D(1)}T10:00`);
  const made = ok(await o.b.call("POST", `${o.crm}/series`, { appointmentId: first.id, count: 4 }), 201);
  assert.equal(made.created.length, 3);
  const ns = await o.list();
  assert.equal(ns.filter((n) => n.kind === "booked").length, 1, "only the first visit was announced");
  assert.equal(ns.filter((n) => n.kind === "reminder" && n.status === "queued").length, 4);
  ok(await o.b.call("POST", `${o.crm}/series/${made.id}/stop`, { from: D(8) }));
  const cancelled = (await o.list()).filter((n) => n.kind === "cancelled");
  assert.equal(cancelled.length, 1, "one message for the visits called off together");
  assert.match(cancelled[0].text, new RegExp(dayText(D(8), "uz")), "about the earliest of them");
  assert.equal((await o.list()).filter((n) => n.kind === "reminder" && n.status === "queued").length, 1);
});

test("repeat bookings: the visits the daily job books get their reminders", async () => {
  const o = await shop();
  const rules = (maxDays) => ({ minNotice: 60, maxDays, cancelUntil: 120, buffer: 0, step: 15, override: true });
  await o.settings({ rules: rules(30) });
  const first = await o.book(`${D(1)}T10:00`);
  const made = ok(await o.b.call("POST", `${o.crm}/series`, { appointmentId: first.id }), 201);
  await o.settings({ rules: rules(60) });
  assert.ok((await extendAll()) > 0);
  const { rows } = await query(
    `SELECT count(*)::int AS visits, count(n.id)::int AS reminders FROM crm_appointments a
       LEFT JOIN crm_notices n ON n.workspace_id = a.workspace_id AND n.item_id = a.id AND n.kind = 'reminder' AND n.status = 'queued'
      WHERE a.workspace_id = $1 AND a.series_id = $2`,
    [o.ws.id, made.id]
  );
  assert.equal(rows[0].reminders, rows[0].visits);
});

test("every way a booking or an order is written reaches Notices: the AI agent's, the public pages', the daily job's", async () => {
  const a = await owner("Kamola Yusupova", "Guldasta");
  const w = `/w/${a.ws.id}`;
  ok(await a.b.call("POST", `${w}/products`, { add: "crm" }));
  const agent = ok(await a.b.call("POST", `${w}/agents`, { name: "Support" }), 201);
  ok(await a.b.call("POST", `${w}/agents/${agent.id}/publish`));
  const o = await shop({ ...a, crm: `${w}/crm` });
  const slug = `notice-paths-${process.pid}`;
  const page = { slug, booking: true, shop: true, description: "", phone: "", address: "", languages: ["uz"], paymentMethods: ["cash"], deliveryMethods: ["pickup"] };
  ok(await o.b.call("PUT", `${o.crm}/settings`, { modules: { booking: true, store: true }, settings: { aiConnected: true, publicPage: page, notices: { orderStep: { steps: ["new"] } } } }));
  const product = (await o.post("/products", { name: "Vase", price: 120000, opening: 5 })).changes.set.products[0];
  const heard = async (id) => (await query("SELECT 1 FROM crm_notice_items WHERE workspace_id = $1 AND item_id = $2", [a.ws.id, id])).rows.length === 1;
  const kinds = async (id) => (await o.about(id)).map((n) => [n.kind, n.status]).sort();

  // The AI agent, for the customer with this phone: book (waiting for the team, nothing to say yet,
  // but heard), the team confirms, then the agent moves and cancels it, and places an order.
  const agentRow = (await query("SELECT * FROM agents WHERE id = $1", [agent.id])).rows[0];
  const cid = (await query("INSERT INTO conversations (workspace_id, agent_id, channel, visitor, visitor_token_hash) VALUES ($1, $2, 'widget', '{}', 'x') RETURNING id", [a.ws.id, agent.id])).rows[0].id;
  const run = (name, args) => runCrmTool({ agent: agentRow, conversationId: cid, tool: { name }, args });
  const confirm = async (name, args) => {
    const { card, output } = await run(name, args);
    assert.ok(card, JSON.stringify(output));
    const out = await decideCrmAction(cid, card.action_id, true);
    assert.equal(out.status, "done", out.error);
    return out.result;
  };
  await run("crm_identify_customer", { phone: "+998901234567", name: "Jasur" });
  const { booking } = await confirm("crm_book", { services: [o.s1], start: `${D(3)}T10:00`, specialist: o.p1 });
  assert.ok(await heard(booking));
  ok(await o.b.call("POST", `${o.crm}/appointments/${booking}/step`, { status: "confirmed" }));
  await confirm("crm_move_booking", { booking, start: `${D(3)}T11:00` });
  await confirm("crm_cancel_booking", { booking });
  assert.deepEqual(await kinds(booking), [["booked", "skipped"], ["cancelled", "queued"], ["moved", "skipped"], ["reminder", "skipped"]]);
  const { order } = await confirm("crm_place_order", { lines: [{ product: product.id, qty: 1 }], delivery: { method: "pickup" } });
  assert.deepEqual(await kinds(order), [["orderStep", "queued"]], "the order's own write is heard, with its source");

  // The public pages: a booking (heard while it waits), its cancel by the customer, an order.
  const pub = (method, path, body) => browser().call(method, `/public/crm/${slug}${path}`, body);
  const made = ok(await pub("POST", "/bookings", { serviceIds: [o.s1], staffId: o.p2, start: `${D(4)}T10:00`, name: "Jasur", phone: "+998 90 123 45 67" }), 201);
  const [{ appointment_id: visit }] = (await query("SELECT appointment_id FROM crm_public_requests WHERE workspace_id = $1 AND ref = $2", [a.ws.id, made.ref])).rows;
  assert.ok(await heard(visit));
  ok(await o.b.call("POST", `${o.crm}/appointments/${visit}/step`, { status: "confirmed" }));
  ok(await pub("POST", `/bookings/${made.ref}/cancel`, { token: made.token }));
  assert.deepEqual(await kinds(visit), [["booked", "skipped"], ["cancelled", "queued"], ["reminder", "skipped"]]);
  const placed = ok(await pub("POST", "/orders", { lines: [{ productId: product.id, variantId: product.variants[0].id, qty: 1 }], name: "Jasur", phone: "+998 90 123 45 67", delivery: { method: "pickup", date: D(2), window: { from: "12:00", to: "15:00" } }, payment: "cash" }), 201);
  const [{ order_id: pageOrder }] = (await query("SELECT order_id FROM crm_public_requests WHERE workspace_id = $1 AND ref = $2", [a.ws.id, placed.ref])).rows;
  assert.deepEqual(await kinds(pageOrder), [["orderStep", "queued"]]);
  // The daily job's own write: the test above ("the visits the daily job books get their reminders").
});

test("booking: given to another customer, the new one is told it is booked and the old one that it is off", async () => {
  const o = await shop();
  const c3 = (await o.post("/customers", { name: "Dilnoza Rahimova", phone: "+998907654321" })).id;
  const made = await o.book(`${D(3)}T10:00`);
  await sendDue();
  ok(await o.b.call("PUT", `${o.crm}/appointments/${made.id}`, { customerId: c3, start: `${D(3)}T11:00` }));
  const ns = await o.about(made.id);
  const who = (id) => (id === o.c1 ? "c1" : id === c3 ? "c3" : id);
  assert.deepEqual(ns.map((n) => [n.kind, who(n.customerId), n.status]).sort(), [["booked", "c1", "sent"], ["booked", "c3", "queued"], ["cancelled", "c1", "queued"], ["reminder", "c3", "queued"]]);
  const text = (kind, name, time) => render(NOTICE_TEXTS[kind].uz, { name, service: HAIRCUT.uz, day: dayText(D(3), "uz"), time });
  assert.equal(ns.find((n) => n.kind === "booked" && n.customerId === c3).text, text("booked", "Dilnoza Rahimova", "11:00"));
  assert.equal(ns.find((n) => n.kind === "cancelled").text, text("cancelled", "Jasur Karimov", "10:00"), "the old customer hears of the visit they were told of");
  assert.equal(ns.find((n) => n.kind === "reminder").text, text("reminder", "Dilnoza Rahimova", "11:00"));
});

test("a message waiting for another try is dropped when its item changes, even when the newer message is switched off", async () => {
  const o = await shop();
  await o.settings({ notices: { cancelled: { on: false }, moved: { on: false } } });
  /** Books a visit whose "booked" message fails its first try and waits for the next. */
  const failedOnce = async (start) => {
    const made = await o.book(start);
    const [booked] = await o.about(made.id);
    sms.answers.push(NETWORK);
    await sendDue();
    assert.deepEqual([(await row(booked.id)).status, (await row(booked.id)).tries], ["queued", 1]);
    return [made.id, booked.id];
  };
  const thenDue = async (id) => {
    await dueNow(id);
    resetSms();
    await sendDue();
    assert.deepEqual(sms.sent, [], "nothing went out");
    const r = await row(id);
    return [r.status, r.reason];
  };

  // Cancelled, with the cancel message off: the old "booked" never goes.
  let [item, msg] = await failedOnce(`${D(2)}T10:00`);
  ok(await o.b.call("POST", `${o.crm}/appointments/${item}/step`, { status: "cancelled" }));
  assert.deepEqual(await thenDue(msg), ["skipped", "superseded"]);

  // Moved, with the move message off: the old time never goes.
  [item, msg] = await failedOnce(`${D(2)}T12:00`);
  ok(await o.b.call("POST", `${o.crm}/appointments/${item}/move`, { start: `${D(2)}T13:00` }));
  assert.deepEqual(await thenDue(msg), ["skipped", "superseded"]);

  // A report that never arrived: checked against the item's kept state when it comes due.
  [item, msg] = await failedOnce(`${D(2)}T15:00`);
  await query("UPDATE crm_notice_items SET state = jsonb_set(state, '{start}', to_jsonb($2::text)) WHERE item_id = $1", [item, `${D(2)}T16:00`]);
  assert.deepEqual(await thenDue(msg), ["skipped", "item_changed"]);

  // An admin can't send again a failed message about a visit that changed since.
  const made = await o.book(`${D(2)}T18:00`);
  const [booked] = await o.about(made.id);
  sms.answers.push({ ok: false, code: "blocked", retry: false });
  await sendDue();
  assert.equal((await row(booked.id)).status, "failed");
  ok(await o.b.call("POST", `${o.crm}/appointments/${made.id}/step`, { status: "cancelled" }));
  const refused = await o.b.call("POST", `${o.crm}/notices/${booked.id}/retry`);
  assert.deepEqual([refused.status, refused.body.code], [409, "item_changed"]);

  // An order: a step's message waiting for a try, then the order is cancelled with that message off.
  await o.settings({ notices: { orderCancelled: { on: false }, orderStep: { steps: ["confirmed"] } } });
  const product = (await o.post("/products", { name: "Vase", price: 120000, opening: 5 })).id;
  const order = (await o.post("/orders", { customerId: o.c1, lines: [{ productId: product, qty: 1 }], delivery: { type: "pickup" } })).id;
  ok(await o.b.call("POST", `${o.crm}/orders/${order}/step`, { to: "confirmed" }));
  const [step] = await o.about(order);
  sms.answers.push(NETWORK);
  await sendDue();
  ok(await o.b.call("POST", `${o.crm}/orders/${order}/cancel`, {}));
  assert.deepEqual(await thenDue(step.id), ["skipped", "superseded"]);
});

test("reports ask who can be reached before they take their lock, so many writes at once never stall the pool", async () => {
  const o = await shop();
  await o.book(`${D(5)}T08:00`);
  assert.equal(sms.lockedReach, 0, "the channels are asked outside the report's transaction");
  // More writes at once than the pool has connections (10). A report that held one while the
  // channel asked for another stalled every write in the process, for good.
  const writes = Promise.all(Array.from({ length: 14 }, (_, i) => o.book(`${D(5)}T${String(9 + i).padStart(2, "0")}:00`)));
  assert.equal(await Promise.race([writes.then(() => "answered"), sleep(15000).then(() => "stalled")]), "answered");
  assert.equal((await o.list()).filter((n) => n.kind === "booked").length, 15);
});

/* ───── Orders ───── */

test("orders: a ticked step and a cancel each queue one message with the order's number, step and sum", async () => {
  const o = await shop();
  await o.settings({ notices: { language: "ru", orderStep: { steps: ["confirmed", "delivering"] } } });
  const product = (await o.post("/products", { name: "Vase", price: 120000, opening: 5 })).id;
  const made = await o.post("/orders", { customerId: o.c1, lines: [{ productId: product, qty: 2 }], delivery: { type: "pickup" } });
  const { number, totals } = made.changes.set.orders[0];
  assert.deepEqual(await o.about(made.id), [], "the first step isn't ticked");
  ok(await o.b.call("POST", `${o.crm}/orders/${made.id}/step`, { to: "confirmed" }));
  ok(await o.b.call("POST", `${o.crm}/orders/${made.id}/step`, { to: "packing" }));
  ok(await o.b.call("PUT", `${o.crm}/orders/${made.id}`, { note: "Ring twice" }));
  let ns = await o.about(made.id);
  assert.deepEqual(ns.map((n) => n.kind), ["orderStep"]);
  assert.equal(ns[0].text, `Jasur Karimov, ваш заказ №${number}: Подтверждён.`);
  assert.deepEqual(ns[0].item, { key: "orders", id: made.id });

  await o.settings({ notices: { language: "uz", orderStep: { text: { uz: "№{number}: {step}, {total}" }, steps: ["delivering"] } } });
  ok(await o.b.call("POST", `${o.crm}/orders/${made.id}/step`, { to: "delivering" }));
  ok(await o.b.call("POST", `${o.crm}/orders/${made.id}/cancel`, {}));
  ns = await o.about(made.id);
  assert.deepEqual(ns.map((n) => [n.kind, n.status]), [["orderStep", "skipped"], ["orderStep", "skipped"], ["orderCancelled", "queued"]], "the newest word replaces what still waits");
  assert.equal(ns[1].text, `№${number}: Yetkazilmoqda, ${moneyText(totals.total, "uz")}`);
  assert.equal(ns[2].text, `Jasur Karimov, №${number} buyurtmangiz bekor qilindi.`);
});

/* ───── Sending ───── */

test("claim race: two workers never send the same message twice", async () => {
  const o = await shop();
  const { rows } = await query(
    `INSERT INTO crm_notices (workspace_id, customer_id, kind, item_key, item_id, channel, address, text, language, status)
     SELECT $1, $2, 'booked', 'appointments', gen_random_uuid(), 'sms', '+998901234567', 'Message ' || n, 'en', 'queued' FROM generate_series(1, 45) n RETURNING id`,
    [o.ws.id, o.c1]
  );
  // Claims alone: three at once share the rows, none twice and none left out (a claim that locked a
  // row without taking it would hide it from the others). Many rounds: the race is timing-dependent.
  for (let round = 0; round < 60; round++) {
    const claims = await Promise.all([claimDue(20), claimDue(20), claimDue(20)]);
    const ids = claims.flat().map((n) => n.id);
    assert.equal(new Set(ids).size, ids.length, `round ${round}: no message was claimed by two workers`);
    assert.equal(ids.length, 45, `round ${round}: every due message was claimed`);
    await query("UPDATE crm_notices SET status = 'queued', tries = 0 WHERE id = ANY($1::uuid[])", [rows.map((r) => r.id)]);
  }

  // Whole runs side by side, with a slow provider so they overlap.
  resetSms();
  sms.delay = 5;
  const runs = await Promise.all([sendDue(), sendDue(), sendDue()]);
  assert.equal(runs.reduce((s, r) => s + r.sent, 0), 45);
  assert.equal(sms.sent.length, 45);
  assert.equal(new Set(sms.sent.map((s) => s.text)).size, 45, "each message went exactly once");
  const states = (await query("SELECT status, tries FROM crm_notices WHERE id = ANY($1::uuid[])", [rows.map((r) => r.id)])).rows;
  assert.ok(states.every((s) => s.status === "sent" && s.tries === 1));
});

test("retry: a failed try waits longer each time, then fails; an admin sends it again; a crash mid-send is never resent by itself", async () => {
  const o = await shop();
  const mate = await teammate(o, "agent");
  const made = await o.book(`${D(2)}T10:00`);
  const [booked] = await o.about(made.id);
  resetSms();
  for (let i = 1; i < MAX_TRIES; i++) {
    sms.answers.push({ ok: false, code: "network", retry: true });
    const before = Date.now();
    await sendDue();
    const r = await row(booked.id);
    assert.deepEqual([r.status, r.reason, r.tries], ["queued", "network", i]);
    const wait = (new Date(r.send_at).getTime() - before) / 1000;
    assert.ok(Math.abs(wait - BACKOFF[i - 1]) < 5, `try ${i} waits ${BACKOFF[i - 1]} s, got ${wait}`);
    await dueNow(booked.id);
  }
  sms.answers.push({ ok: false, code: "network", retry: true });
  await sendDue();
  assert.deepEqual([(await row(booked.id)).status, (await row(booked.id)).tries], ["failed", MAX_TRIES]);

  assert.equal((await mate.b.call("POST", `${o.crm}/notices/${booked.id}/retry`)).status, 403, "sending again is for admins");
  const again = ok(await o.b.call("POST", `${o.crm}/notices/${booked.id}/retry`));
  assert.deepEqual([again.changes.set.notices[0].status, again.changes.set.notices[0].tries], ["queued", 0]);
  await drainJobs();
  assert.equal((await row(booked.id)).status, "sent");
  assert.equal((await o.b.call("POST", `${o.crm}/notices/${booked.id}/retry`)).body.code, "not_failed");

  // A refusal that won't change with time fails at once.
  const next = await o.book(`${D(2)}T12:00`);
  const [b2, r2] = await o.about(next.id);
  sms.answers.push({ ok: false, code: "blocked", retry: false });
  await sendDue();
  assert.deepEqual([(await row(b2.id)).status, (await row(b2.id)).reason, (await row(b2.id)).tries], ["failed", "blocked", 1]);

  // Left in `sending` by a worker that died: failed, never sent again by itself.
  await query("UPDATE crm_notices SET status = 'sending', claimed_at = now() - interval '11 minutes' WHERE id = $1", [r2.id]);
  resetSms();
  await sendDue();
  assert.deepEqual([(await row(r2.id)).status, (await row(r2.id)).reason, sms.sent.length], ["failed", "interrupted", 0]);
  // A failed reminder can't be sent again while a newer one for the same visit waits.
  ok(await o.b.call("POST", `${o.crm}/appointments/${next.id}/move`, { start: `${D(2)}T13:00` }));
  assert.equal((await o.b.call("POST", `${o.crm}/notices/${r2.id}/retry`)).body.code, "reminder_waiting");
});

test("telegram: a customer who wrote to the workspace's bot gets the message there, in their conversation's language", async () => {
  const calls = [];
  let answer = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const method = req.url.split("/").pop();
      calls.push({ method, body: body ? JSON.parse(body) : {} });
      if (method === "sendMessage" && answer) return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(answer));
      const result = method === "getMe" ? { id: 99001, username: "guldasta_bot", first_name: "Guldasta" } : method === "sendMessage" ? { message_id: 1 } : true;
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  process.env.TELEGRAM_API = `http://127.0.0.1:${server.address().port}`;
  try {
    const a = await owner("Kamola Yusupova", "Guldasta");
    const w = `/w/${a.ws.id}`;
    ok(await a.b.call("POST", `${w}/products`, { add: "crm" }));
    // How a message can reach a customer here, in one cheap answer for the Messages screen. The
    // fake SMS provider of these tests reaches everyone with a phone, in every workspace.
    const reach = async (b = a.b, at = w) => {
      const r = ok(await b.call("GET", `${at}/crm/notices/reach`));
      return { ...r, channels: [...r.channels].sort() };
    };
    assert.deepEqual(await reach(), { reach: "nobot", channels: ["sms"] }, "the AI agent, no bot yet");
    const crmOnly = await crmOwner();
    assert.deepEqual(await reach(crmOnly.b, `/w/${crmOnly.ws.id}`), { reach: "noagent", channels: ["sms"] });
    const agent = ok(await a.b.call("POST", `${w}/agents`, { name: "Support" }), 201);
    const channel = ok(await a.b.call("POST", `${w}/agents/${agent.id}/channels/telegram`, { bot_token: "99001:AAEhBOweik6ad9r_TestTokenForNotices01" }), 201);
    assert.deepEqual(await reach(), { reach: "bot", channels: ["sms", "telegram"] });
    const mate = await teammate(a, "agent");
    assert.equal((await reach(mate.b)).reach, "bot", "the team may ask too");
    await query("UPDATE agent_channels SET status = 'disabled' WHERE id = $1", [channel.id]);
    assert.equal((await reach()).reach, "nobot", "a bot whose token was revoked reaches nobody");
    await query("UPDATE agent_channels SET status = 'active' WHERE id = $1", [channel.id]);
    await query(
      `INSERT INTO conversations (workspace_id, agent_id, channel, channel_id, channel_chat_id, visitor, visitor_token_hash)
       VALUES ($1, $2, 'telegram', $3, '555001', $4, 'x')`,
      [a.ws.id, agent.id, channel.id, { name: "Jasur", language: "ru", telegram_username: "Jasur_K", telegram_user_id: "555001" }]
    );
    const o = await shop({ ...a, crm: `${w}/crm` });
    ok(await o.b.call("PUT", `${o.crm}/customers/${o.c1}`, { telegram: "@jasur_k" }));
    const made = await o.book(`${D(2)}T10:00`);
    const [booked] = await o.about(made.id);
    assert.deepEqual([booked.channel, booked.language], ["telegram", "ru"], "Telegram comes before SMS, in the language of the chat");
    assert.equal(booked.text, render(NOTICE_TEXTS.booked.ru, { name: "Jasur Karimov", service: HAIRCUT.ru, day: dayText(D(2), "ru"), time: "10:00" }));
    await sendDue();
    const sent = calls.filter((c) => c.method === "sendMessage");
    assert.deepEqual(sent.map((c) => [c.body.chat_id, c.body.text]), [["555001", booked.text]]);
    assert.equal((await row(booked.id)).status, "sent");

    answer = { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" };
    ok(await o.b.call("POST", `${o.crm}/appointments/${made.id}/move`, { start: `${D(2)}T11:00` }));
    const moved = (await o.about(made.id)).find((n) => n.kind === "moved");
    await sendDue();
    assert.deepEqual([(await row(moved.id)).status, (await row(moved.id)).reason], ["failed", "blocked"]);
    assert.ok(!JSON.stringify(await o.list()).includes("555001"), "the chat address never leaves the server");
  } finally {
    server.close();
    delete process.env.TELEGRAM_API;
  }
});

/* ───── Reading, tenancy and roles ───── */

test("list: newest first, by customer and by item, paged; in the snapshot; announced live", async () => {
  const o = await shop();
  const stream = await fetch(`${base}/w/${o.ws.id}/crm/stream`, { headers: { Cookie: o.b.cookie, "CF-Connecting-IP": "198.51.100.31" } });
  const reader = stream.body.getReader();
  let heard = "";
  const listen = (async () => {
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) return;
      heard += decoder.decode(value);
    }
  })();
  await sleep(100);
  const a = await o.book(`${D(2)}T10:00`);
  const b = await o.book(`${D(2)}T12:00`, { customerId: o.c2 });
  const all = await o.list();
  assert.equal(all.length, 4);
  assert.ok(all[0].createdAt >= all[3].createdAt);
  assert.deepEqual((await o.list(`?customerId=${o.c2}`)).map((n) => n.item.id), [b.id, b.id]);
  assert.deepEqual((await o.list(`?itemId=${a.id}`)).map((n) => n.kind).sort(), ["booked", "reminder"]);
  const page1 = ok(await o.b.call("GET", `${o.crm}/notices?limit=3`));
  assert.equal(page1.notices.length, 3);
  const page2 = ok(await o.b.call("GET", `${o.crm}/notices?limit=3&before=${page1.next}`));
  assert.deepEqual([...page1.notices, ...page2.notices].map((n) => n.id), all.map((n) => n.id));
  assert.equal(page2.next, null);
  assert.equal((await o.b.call("GET", `${o.crm}/notices?itemId=nope`)).status, 400);

  const snap = ok(await o.b.call("GET", `${o.crm}/snapshot?only=notices`));
  assert.deepEqual(snap.notices.map((n) => n.id), all.map((n) => n.id));
  await sleep(400);
  reader.cancel();
  await listen;
  assert.match(heard, /event: crm\ndata: \{"k":\[[^\]]*"notices"/);
});

test("tenancy and roles: another workspace sees and retries nothing; a specialist who sees only their own bookings sees only their messages", async () => {
  const o = await shop();
  const other = await shop(await crmOwner("Other Owner", "Other"));
  const mine = await o.book(`${D(2)}T10:00`);
  await other.book(`${D(2)}T10:00`);
  const [booked] = await o.about(mine.id);
  assert.equal((await other.list()).some((n) => n.item.id === mine.id), false);
  assert.deepEqual(await other.list(`?itemId=${mine.id}`), []);
  assert.deepEqual(await other.list(`?customerId=${o.c1}`), []);
  await query("UPDATE crm_notices SET status = 'failed' WHERE id = $1", [booked.id]);
  assert.equal((await other.b.call("POST", `${other.crm}/notices/${booked.id}/retry`)).status, 404);
  assert.equal((await o.b.call("POST", `${o.crm}/notices/not-an-id/retry`)).status, 404);
  assert.equal((await other.b.call("GET", `${o.crm}/notices`)).status, 404, "not a member");

  // A team member reads the list; one linked to a specialist with ownOnly sees only that specialist's booking messages.
  const mate = await teammate(o, "agent", "Bek Aliyev");
  assert.equal((await o.list("", mate.b)).length, 2);
  ok(await o.b.call("PUT", `${o.crm}/staff/${o.p2}`, { userId: mate.user.id, ownOnly: true }));
  const theirs = await o.book(`${D(2)}T10:00`, { staffId: o.p2, customerId: o.c2 });
  const product = (await o.post("/products", { name: "Vase", price: 1000, opening: 1 })).id;
  await o.settings({ notices: { orderStep: { steps: ["new"] } } });
  const order = (await o.post("/orders", { customerId: o.c1, lines: [{ productId: product, qty: 1 }], delivery: { type: "pickup" } })).id;
  const seen = await o.list("", mate.b);
  assert.deepEqual([...new Set(seen.map((n) => n.item.id))].sort(), [theirs.id, order].sort());
  assert.deepEqual([...new Set(ok(await mate.b.call("GET", `${o.crm}/snapshot?only=notices`)).notices.map((n) => n.item.id))].sort(), [theirs.id, order].sort());
  assert.equal((await o.list()).length, 5, "admins and the owner see everything");
  assert.equal((await mate.b.call("PUT", `${o.crm}/settings`, { settings: { notices: { language: "en" } } })).status, 403);
});

