// The Booking module through its API: the team, services, time off, bookings with every rule both
// ways, repeat bookings, roles, tenancy, the race for one time, and live updates.
// "Now" is the server's real clock in the workspace's time zone, so days are counted from today.
import assert from "node:assert/strict";
import { test } from "node:test";
import { crmOwner, teammate, base, query, drainJobs } from "./helpers/setup.js";
import { nowIn, addDays, dayOf, weekday } from "../src/crm/shared/time.js";
import { seriesDays } from "../src/crm/shared/booking.js";
import { extendAll } from "../src/crm/booking/series-job.js";

const today = () => dayOf(nowIn("Asia/Tashkent", new Date()));
const D = (n) => addDays(today(), n);
const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, ["00:00", "24:00"]]));
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const codes = (list) => (list || []).map((r) => r.code);
const snap = async (o, only) => (await o.b.call("GET", `${o.crm}/snapshot${only ? `?only=${only}` : ""}`)).body;

/** A CRM workspace with two services, two specialists who work around the clock, and a customer. */
async function shop() {
  const o = await crmOwner();
  const post = (path, body, status = 201) => o.b.call("POST", o.crm + path, body).then((r) => ok(r, status));
  const s1 = (await post("/services", { name: "Haircut", duration: 30, price: 50000 })).id;
  const s2 = (await post("/services", { name: { en: "Colour", ru: "Окрашивание", uz: "Boʻyash" }, duration: 60, price: 90000, buffer: 15 })).id;
  const p1 = (await post("/staff", { name: "Aziz", role: "Barber", hours: ALL_DAY, serviceIds: [s1, s2] })).id;
  const p2 = (await post("/staff", { name: "Bek", hours: ALL_DAY, serviceIds: [s1] })).id;
  const c1 = (await post("/customers", { name: "Jasur Karimov", phone: "+998901234567" })).id;
  const c2 = (await post("/customers", { name: "Malika Aliyeva" })).id;
  const book = (body, b = o.b) => b.call("POST", `${o.crm}/appointments`, { customerId: c1, staffId: p1, serviceIds: [s1], ...body });
  const rules = (over) => o.b.call("PUT", `${o.crm}/settings`, { settings: { rules: { minNotice: 60, maxDays: 30, cancelUntil: 120, buffer: 0, step: 15, override: true, ...over } } }).then((r) => ok(r));
  return { ...o, s1, s2, p1, p2, c1, c2, book, post, rules };
}

/** Opens an event stream like a browser does and collects what arrives. */
async function openStream(path, cookie) {
  const ctl = new AbortController();
  const res = await fetch(base + path, { headers: { "CF-Connecting-IP": "198.51.100.19", Cookie: cookie }, signal: ctl.signal });
  const events = [];
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
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (data !== undefined) events.push({ event: /^event: (.*)$/m.exec(block)?.[1] || "message", data: JSON.parse(data) });
        }
      }
    } catch {
      // aborted
    }
  })();
  return {
    async next(match, ms = 3000) {
      const end = Date.now() + ms;
      for (;;) {
        const hit = events.find(match);
        if (hit || Date.now() > end) return hit || null;
        await new Promise((r) => setTimeout(r, 30));
      }
    },
    close: () => ctl.abort(),
  };
}

test("services: create, edit, switch off; a category must exist", async () => {
  const o = await shop();
  const made = ok(await o.b.call("POST", `${o.crm}/services`, { name: "Shave", duration: 20, price: 30000, buffer: 5 }), 201);
  assert.deepEqual(made.changes.set.services, [{ id: made.id, name: "Shave", category: "", duration: 20, price: 30000, buffer: 5, active: true }]);
  assert.equal(typeof made.rev, "number");
  const edited = ok(await o.b.call("PUT", `${o.crm}/services/${made.id}`, { price: 35000, buffer: null, active: false }));
  assert.deepEqual(edited.changes.set.services[0], { id: made.id, name: "Shave", category: "", duration: 20, price: 35000, buffer: null, active: false });
  assert.equal((await o.b.call("PUT", `${o.crm}/services/${made.id}`, { category: "nope" })).body.code, "bad_category");
  ok(await o.b.call("PUT", `${o.crm}/settings`, { serviceCategories: [{ id: "hair", name: "Hair" }] }));
  ok(await o.b.call("PUT", `${o.crm}/services/${made.id}`, { category: "hair" }));
  // The category is in use now: core refuses to remove it, asking this module for the count.
  const inUse = await o.b.call("PUT", `${o.crm}/settings`, { serviceCategories: [] });
  assert.equal(inUse.status, 409);
  assert.deepEqual([inUse.body.code, inUse.body.list, inUse.body.id, inUse.body.count], ["in_use", "serviceCategories", "hair", 1]);
  for (const bad of [{ name: "", duration: 30 }, { name: "X", duration: 0 }, { name: "X", duration: 30, price: 1.5 }, { name: "X", duration: 30, extra: 1 }]) {
    assert.equal((await o.b.call("POST", `${o.crm}/services`, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await o.b.call("PUT", `${o.crm}/services/not-an-id`, { price: 1 })).status, 404);
  const s = await snap(o, "services");
  assert.deepEqual(s.services.map((x) => x.name), ["Haircut", { en: "Colour", ru: "Окрашивание", uz: "Boʻyash" }, "Shave"]);
});

test("the team: create, edit, link to a login; bad services, hours and users are refused", async () => {
  const o = await shop();
  const mate = await teammate(o, "agent");
  const hours = { ...ALL_DAY, 0: null, 1: ["10:00", "20:00"] };
  const made = ok(await o.b.call("POST", `${o.crm}/staff`, { name: " Dilnoza ", role: { en: "Therapist", ru: "Терапевт", uz: "Terapevt" }, tone: "t3", hours, breaks: [{ from: "15:00", to: "15:30" }, { from: "13:00", to: "14:00" }], serviceIds: [o.s1], userId: mate.user.id, ownOnly: true }), 201);
  const row = made.changes.set.staff[0];
  assert.deepEqual(
    { ...row, branchId: null },
    { id: made.id, name: "Dilnoza", role: { en: "Therapist", ru: "Терапевт", uz: "Terapevt" }, tone: "t3", hours, breaks: [{ from: "13:00", to: "14:00" }, { from: "15:00", to: "15:30" }], serviceIds: [o.s1], active: true, userId: mate.user.id, ownOnly: true, branchId: null }
  );
  const s = await snap(o);
  assert.equal(row.branchId, s.branches[0].id, "a specialist belongs to the default branch");
  assert.equal((await snap(mate.b ? { b: mate.b, crm: o.crm } : o, "me")).me.staffId, made.id, "the linked team member is told which specialist they are");
  assert.equal(s.me.staffId, null);

  const twin = await o.b.call("PUT", `${o.crm}/staff/${o.p1}`, { userId: mate.user.id });
  assert.deepEqual([twin.status, twin.body.code, twin.body.staffId], [409, "user_taken", made.id]);
  const far = await crmOwner();
  assert.equal((await o.b.call("PUT", `${o.crm}/staff/${o.p1}`, { userId: far.user.id })).body.code, "bad_user");
  assert.equal((await o.b.call("PUT", `${o.crm}/staff/${o.p1}`, { serviceIds: [o.s1, far.ws.id] })).body.code, "bad_service");
  for (const bad of [{ hours: { ...ALL_DAY, 1: ["20:00", "10:00"] } }, { hours: { 1: ["10:00", "20:00"] } }, { breaks: [{ from: "14:00", to: "13:00" }] }, { tone: "pink" }, { name: "" }]) {
    assert.equal((await o.b.call("PUT", `${o.crm}/staff/${o.p1}`, bad)).status, 400, JSON.stringify(bad));
  }
  const edited = ok(await o.b.call("PUT", `${o.crm}/staff/${made.id}`, { userId: null, ownOnly: false, role: "Senior therapist" }));
  assert.deepEqual([edited.changes.set.staff[0].userId, edited.changes.set.staff[0].role], [null, "Senior therapist"]);

  // Setting up the team and services is for admins.
  for (const [method, path, body] of [["POST", "/staff", { name: "X", hours: ALL_DAY }], ["PUT", `/staff/${o.p1}`, { name: "X" }], ["DELETE", `/staff/${o.p1}`], ["POST", "/services", { name: "X", duration: 30 }], ["PUT", `/services/${o.s1}`, { price: 1 }], ["DELETE", `/services/${o.s1}`]]) {
    assert.equal((await mate.b.call(method, o.crm + path, body)).status, 403, `${method} ${path}`);
  }
});

test("a specialist or a service with bookings ahead can't be removed or switched off by surprise", async () => {
  const o = await shop();
  const a = ok(await o.book({ start: `${D(3)}T10:00` }), 201);
  const off = await o.b.call("PUT", `${o.crm}/staff/${o.p1}`, { active: false });
  assert.deepEqual([off.status, off.body.code, off.body.count, off.body.ids], [409, "staff_has_bookings", 1, [a.id]]);
  const gone = await o.b.call("DELETE", `${o.crm}/staff/${o.p1}`);
  assert.deepEqual([gone.status, gone.body.code, gone.body.count], [409, "staff_has_bookings", 1]);
  const service = await o.b.call("DELETE", `${o.crm}/services/${o.s1}`);
  assert.deepEqual([service.status, service.body.code, service.body.count, service.body.ids], [409, "service_has_bookings", 1, [a.id]]);

  // New hours are saved; the answer says which bookings ahead no longer fit them.
  const wd = weekday(D(3));
  const hours = ok(await o.b.call("PUT", `${o.crm}/staff/${o.p1}`, { hours: { ...ALL_DAY, [wd]: ["12:00", "20:00"] } }));
  assert.deepEqual(hours.outside, { count: 1, ids: [a.id] });
  assert.deepEqual(ok(await o.b.call("PUT", `${o.crm}/staff/${o.p1}`, { hours: ALL_DAY, breaks: [{ from: "09:00", to: "09:30" }] })).outside, { count: 0, ids: [] });

  // Once the booking is cancelled nothing is ahead: the specialist can be switched off, the service deleted.
  ok(await o.b.call("POST", `${o.crm}/appointments/${a.id}/step`, { status: "cancelled" }));
  ok(await o.b.call("PUT", `${o.crm}/staff/${o.p1}`, { active: false }));
  assert.equal((await o.b.call("DELETE", `${o.crm}/staff/${o.p1}`)).body.code, "staff_has_bookings", "the cancelled booking still points at them");
  const del = ok(await o.b.call("DELETE", `${o.crm}/services/${o.s1}`));
  assert.deepEqual(del.changes.del, { services: [o.s1] });
  assert.deepEqual(del.changes.set.staff.map((p) => [p.id, p.serviceIds]).sort(), [[o.p1, [o.s2]], [o.p2, []]].sort());
  const s = await snap(o);
  assert.deepEqual(s.appointments[0].serviceIds, [o.s1], "the old booking keeps the removed service's id");
  // Nobody was ever booked with Bek: deleted, with their time off.
  const blocked = ok(await o.b.call("POST", `${o.crm}/time-off`, { staffId: o.p2, start: `${D(5)}T00:00`, end: `${D(5)}T23:59` }), 201);
  assert.deepEqual(ok(await o.b.call("DELETE", `${o.crm}/staff/${o.p2}`)).changes.del, { staff: [o.p2], timeOff: [blocked.id] });
  assert.deepEqual((await snap(o, "staff,timeOff")).timeOff, []);
});

test("time off: for one person or everyone; bookings inside are reported, never cancelled", async () => {
  const o = await shop();
  const a1 = ok(await o.book({ start: `${D(4)}T10:00` }), 201).id;
  const a2 = ok(await o.book({ start: `${D(4)}T10:00`, staffId: o.p2 }), 201).id;
  const one = ok(await o.b.call("POST", `${o.crm}/time-off`, { staffId: o.p1, start: `${D(4)}T09:00`, end: `${D(4)}T11:59`, note: "Training" }), 201);
  assert.deepEqual(one.changes.set.timeOff[0], { id: one.id, staffId: o.p1, start: `${D(4)}T09:00`, end: `${D(4)}T11:59`, note: "Training", branchId: one.changes.set.timeOff[0].branchId });
  assert.deepEqual(one.inside, { count: 1, ids: [a1] });
  const all = ok(await o.b.call("POST", `${o.crm}/time-off`, { start: `${D(4)}T00:00`, end: `${D(5)}T23:59`, note: { en: "Holiday", ru: "Праздник", uz: "Bayram" } }), 201);
  assert.equal(all.changes.set.timeOff[0].staffId, null);
  assert.deepEqual([all.inside.count, [...all.inside.ids].sort()], [2, [a1, a2].sort()]);
  const s = await snap(o);
  assert.deepEqual(s.appointments.map((a) => a.status), ["confirmed", "confirmed"], "the bookings stay as they were");
  assert.equal(s.timeOff.length, 2);

  const moved = ok(await o.b.call("PUT", `${o.crm}/time-off/${one.id}`, { start: `${D(4)}T10:30`, end: `${D(4)}T10:59`, note: "" }));
  assert.deepEqual([moved.changes.set.timeOff[0].start, moved.changes.set.timeOff[0].note, moved.inside.count], [`${D(4)}T10:30`, "", 0]);
  assert.equal((await o.b.call("PUT", `${o.crm}/time-off/${one.id}`, { end: `${D(4)}T10:00` })).body.code, "bad_span");
  assert.equal((await o.b.call("POST", `${o.crm}/time-off`, { staffId: o.c1, start: `${D(4)}T10:00`, end: `${D(4)}T11:00` })).body.code, "bad_staff");
  assert.equal((await o.b.call("POST", `${o.crm}/time-off`, { start: "tomorrow", end: `${D(4)}T11:00` })).status, 400);
  assert.deepEqual(ok(await o.b.call("DELETE", `${o.crm}/time-off/${one.id}`)).changes, { del: { timeOff: [one.id] } });
  assert.equal((await o.b.call("DELETE", `${o.crm}/time-off/${one.id}`)).status, 404);
  // A team member may block time too.
  const mate = await teammate(o, "agent");
  ok(await mate.b.call("POST", `${o.crm}/time-off`, { staffId: o.p2, start: `${D(8)}T10:00`, end: `${D(8)}T10:59` }), 201);
});

test("a booking the team makes: starts confirmed, takes length and price from its services", async () => {
  const o = await shop();
  const r = ok(await o.book({ start: `${D(2)}T14:20`, serviceIds: [o.s1, o.s2], source: "phone", note: "First visit" }), 201);
  const a = r.changes.set.appointments[0];
  assert.equal(a.id, r.id);
  assert.deepEqual(
    { ...a, createdAt: "", branchId: "" },
    { id: r.id, customerId: o.c1, staffId: o.p1, serviceIds: [o.s1, o.s2], start: `${D(2)}T14:20`, duration: 90, price: 140000, status: "confirmed", source: "phone", note: "First visit", paid: false, fields: {}, history: [], seriesId: null, seriesDay: null, branchId: "", createdAt: "", createdBy: { by: o.user.name, byId: o.user.id } }
  );
  assert.match(a.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.deepEqual((await snap(o, "appointments")).appointments, [a]);
  // Its own length and price, when given.
  const own = ok(await o.book({ start: `${D(2)}T16:30`, duration: 45, price: 0 }), 201).changes.set.appointments[0];
  assert.deepEqual([own.duration, own.price], [45, 0]);
  // Anyone: the first specialist who is free then.
  const any = ok(await o.book({ start: `${D(2)}T14:30`, staffId: null }), 201).changes.set.appointments[0];
  assert.equal(any.staffId, o.p2);
  // A board without a pending step in front: still the first booked step.
  ok(await o.b.call("PUT", `${o.crm}/settings`, { apptStages: [{ id: "vip", name: "VIP desk", tone: "", kind: "booked" }, ...(await snap(o)).apptStages] }));
  assert.equal(ok(await o.book({ start: `${D(2)}T18:00` }), 201).changes.set.appointments[0].status, "vip");
});

test("what a booking needs: a customer, known services, a known source, valid and required fields", async () => {
  const o = await shop();
  const far = await shop();
  const at = `${D(2)}T10:00`;
  assert.equal((await o.book({ start: at, customerId: far.c1 })).body.code, "bad_customer");
  assert.equal((await o.book({ start: at, serviceIds: [far.s1] })).body.code, "bad_service");
  assert.equal((await o.book({ start: at, source: "carrier-pigeon" })).body.code, "bad_source");
  assert.equal((await o.book({ start: at, source: "ai" })).body.code, "bad_source", "only the AI agent marks a booking as its own");
  for (const bad of [{ start: `${D(2)} 10:00` }, { start: at, serviceIds: [] }, { start: at, duration: 0 }, { start: at, price: -1 }, { start: at, staffId: "p1" }, { start: at, status: "done" }]) {
    assert.equal((await o.book(bad)).status, 400, JSON.stringify(bad));
  }
  ok(await o.b.call("PUT", `${o.crm}/services/${o.s2}`, { active: false }));
  const offS = await o.book({ start: at, serviceIds: [o.s2] });
  assert.deepEqual([offS.status, offS.body.code, offS.body.serviceId], [400, "service_off", o.s2]);

  ok(await o.b.call("PUT", `${o.crm}/settings`, { fields: { appointment: [{ id: "room", name: "Room", type: "number", required: true }, { id: "first", name: "First visit", type: "yesno" }] } }));
  const missing = await o.book({ start: at });
  assert.deepEqual([missing.status, missing.body.code, missing.body.fields], [400, "missing_fields", ["room"]]);
  const wrong = await o.book({ start: at, fields: { room: "three" } });
  assert.deepEqual([wrong.status, wrong.body.code, wrong.body.fields], [400, "bad_fields", { room: "bad_value" }]);
  const made = ok(await o.book({ start: at, fields: { room: 3, first: true, unknown: "x" } }), 201);
  assert.deepEqual(made.changes.set.appointments[0].fields, { room: 3, first: true });
  const edited = ok(await o.b.call("PUT", `${o.crm}/appointments/${made.id}`, { fields: { first: null } }));
  assert.deepEqual(edited.changes.set.appointments[0].fields, { room: 3 });
  assert.deepEqual(edited.changes.set.appointments[0].history.map((x) => x.type), ["fields"]);
  assert.deepEqual(ok(await o.b.call("PUT", `${o.crm}/appointments/${made.id}`, { fields: { room: 3 } })).changes, {}, "the same values write nothing");
  assert.equal((await o.b.call("PUT", `${o.crm}/appointments/${made.id}`, { fields: { room: "" } })).body.code, "missing_fields");
});

test("hard reasons refuse a booking, with force too", async () => {
  const o = await shop();
  const first = ok(await o.book({ start: `${D(2)}T10:00`, duration: 60 }), 201);
  const expect = async (body, code, extra = {}) => {
    for (const force of [false, true]) {
      const r = await o.book({ ...body, force });
      assert.equal(r.status, 422, `${code}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, "rules");
      const reason = r.body.hard.find((x) => x.code === code);
      assert.ok(reason, `${code} in ${JSON.stringify(r.body.hard)}`);
      for (const [k, v] of Object.entries(extra)) assert.deepEqual(reason[k], v, `${code}.${k}`);
    }
  };
  await expect({ start: `${D(2)}T10:30` }, "taken", { staffId: o.p1, id: first.id, from: "10:00", to: "11:00" });
  await expect({ start: `${D(2)}T09:45` }, "taken");
  await expect({ start: `${D(2)}T12:00`, staffId: o.p2, serviceIds: [o.s2] }, "service_not_done", { staffId: o.p2, serviceId: o.s2 });
  await expect({ start: `${D(-1)}T12:00` }, "day_passed");
  await expect({ start: `${D(2)}T23:45` }, "ends_next_day");
  await expect({ start: `${D(2)}T12:00`, staffId: o.c1 }, "no_staff");
  ok(await o.b.call("PUT", `${o.crm}/staff/${o.p2}`, { active: false }));
  await expect({ start: `${D(2)}T12:00`, staffId: o.p2 }, "staff_off", { staffId: o.p2 });
  // Back to back is fine, and so is midnight as the end.
  ok(await o.book({ start: `${D(2)}T11:00` }), 201);
  ok(await o.book({ start: `${D(2)}T09:30` }), 201);
  ok(await o.book({ start: `${D(2)}T23:30` }), 201);
  assert.equal((await snap(o, "appointments")).appointments.length, 4, "nothing refused was saved");
});

test("soft reasons: refused, booked with force, and refused with force when the workspace switched override off", async () => {
  const o = await shop();
  // Thursday-like setup on day 3: Aziz works 10:00–18:00 with a break, is away for an hour, the business closes on day 5.
  const wd = weekday(D(3));
  const off = weekday(D(6));
  ok(await o.b.call("PUT", `${o.crm}/staff/${o.p1}`, { hours: { ...ALL_DAY, [wd]: ["10:00", "18:00"], [off]: null }, breaks: [{ from: "13:00", to: "14:00" }] }));
  const away = ok(await o.b.call("POST", `${o.crm}/time-off`, { staffId: o.p1, start: `${D(3)}T16:00`, end: `${D(3)}T16:59`, note: "Dentist" }), 201).id;
  const closed = ok(await o.b.call("POST", `${o.crm}/time-off`, { start: `${D(5)}T00:00`, end: `${D(5)}T23:59` }), 201).id;
  await o.rules({ buffer: 10 });
  ok(await o.book({ start: `${D(3)}T11:00`, customerId: o.c2 }), 201);
  const cases = [
    ["outside_hours", { start: `${D(3)}T09:30` }, { staffId: o.p1, from: "10:00", to: "18:00" }],
    ["outside_hours", { start: `${D(3)}T17:45` }, {}],
    ["day_off", { start: `${D(6)}T12:00` }, { staffId: o.p1, weekday: off }],
    ["break", { start: `${D(3)}T12:45` }, { from: "13:00", to: "14:00" }],
    ["away", { start: `${D(3)}T15:45` }, { id: away, note: "Dentist", start: `${D(3)}T16:00`, end: `${D(3)}T16:59` }],
    ["closed", { start: `${D(5)}T12:00`, staffId: o.p2 }, { id: closed }],
    ["max_days", { start: `${D(31)}T12:00`, staffId: o.p2 }, { days: 30 }],
    ["time_passed", { start: `${D(0)}T00:00`, staffId: o.p2, duration: 1 }, {}],
    ["buffer_before", { start: `${D(3)}T11:35` }, { minutes: 10, until: "11:40" }],
    ["buffer_after", { start: `${D(3)}T10:25` }, { minutes: 10, next: "11:00" }],
    // The service's own buffer (15) wins over the rule (10).
    ["buffer_after", { start: `${D(3)}T14:00`, serviceIds: [o.s2], duration: 30 }, { minutes: 15, next: "14:40" }, { start: `${D(3)}T14:40` }],
  ];
  for (const [code, body, params, before] of cases) {
    if (before) ok(await o.book({ ...before, customerId: o.c2 }), 201);
    const plain = await o.book(body);
    assert.equal(plain.status, 422, `${code}: ${JSON.stringify(plain.body)}`);
    assert.deepEqual([plain.body.code, plain.body.hard, plain.body.override], ["rules", [], true], code);
    const reason = plain.body.soft.find((x) => x.code === code);
    assert.ok(reason, `${code} in ${JSON.stringify(plain.body.soft)}`);
    for (const [k, v] of Object.entries(params)) assert.deepEqual(reason[k], v, `${code}.${k}`);
    // The same question, asked without saving, gets the same answer.
    const asked = ok(await o.b.call("POST", `${o.crm}/booking/check`, { staffId: body.staffId || o.p1, serviceIds: body.serviceIds || [o.s1], start: body.start, duration: body.duration }));
    assert.deepEqual([asked.hard, asked.soft, asked.ok, asked.canForce], [[], plain.body.soft, false, true], code);
  }
  // Override off: force changes nothing.
  await o.rules({ buffer: 10, override: false });
  for (const [code, body] of cases) {
    const r = await o.book({ ...body, force: true });
    assert.equal(r.status, 422, code);
    assert.deepEqual([r.body.override, codes(r.body.soft).includes(code)], [false, true], code);
  }
  assert.equal(ok(await o.b.call("POST", `${o.crm}/booking/check`, { staffId: o.p1, serviceIds: [o.s1], start: `${D(3)}T09:30` })).canForce, false);
  // Override on: force books it and says which rules were passed.
  await o.rules({ buffer: 10, override: true });
  for (const [code, body] of cases) {
    const r = await o.book({ ...body, force: true });
    assert.equal(r.status, 201, `${code}: ${JSON.stringify(r.body)}`);
    assert.ok(codes(r.body.forced).includes(code), code);
    // Clear the way for the next case.
    ok(await o.b.call("DELETE", `${o.crm}/appointments/${r.body.id}`));
  }
  // Minimum notice: a day, so tomorrow at 00:00 is too soon, the day after tomorrow at 23:00 is not.
  await o.rules({ minNotice: 1440 });
  const soon = await o.book({ start: `${D(1)}T00:00`, staffId: o.p2 });
  assert.deepEqual([soon.status, soon.body.soft], [422, [{ code: "min_notice", minutes: 1440 }]]);
  ok(await o.book({ start: `${D(2)}T23:00`, staffId: o.p2 }), 201);
});

test("editing: details are always fine, a new time goes through the rules, history says what moved", async () => {
  const o = await shop();
  const a = ok(await o.book({ start: `${D(3)}T10:00` }), 201).id;
  const b = ok(await o.book({ start: `${D(3)}T12:00`, customerId: o.c2 }), 201).id;
  const put = (id, body) => o.b.call("PUT", `${o.crm}/appointments/${id}`, body);
  // The time is now outside the rules (the business closed that day): details still save.
  ok(await o.b.call("POST", `${o.crm}/time-off`, { start: `${D(3)}T00:00`, end: `${D(3)}T23:59` }), 201);
  const noted = ok(await put(a, { note: "Asked for a reminder", customerId: o.c2, price: 45000, source: "telegram" })).changes.set.appointments[0];
  assert.deepEqual([noted.note, noted.customerId, noted.price, noted.source], ["Asked for a reminder", o.c2, 45000, "telegram"]);
  assert.deepEqual(noted.history.map((x) => [x.type, x.by]), [["note", o.user.name]], "a new note is a line in the history");
  assert.deepEqual(ok(await put(a, { note: "Asked for a reminder" })).changes, {}, "nothing changed, nothing written");
  // A new time: soft reason, then with force.
  const soft = await put(a, { start: `${D(3)}T10:30` });
  assert.deepEqual([soft.status, codes(soft.body.soft)], [422, ["closed"]]);
  const forced = ok(await put(a, { start: `${D(3)}T10:30`, force: true }));
  assert.deepEqual(codes(forced.forced), ["closed"]);
  const h = forced.changes.set.appointments[0].history;
  assert.equal(h.length, 2);
  assert.deepEqual({ ...h[1], at: "" }, { at: "", by: o.user.name, byId: o.user.id, type: "moved", from: `${D(3)}T10:00`, to: `${D(3)}T10:30`, fromStaff: o.p1, toStaff: o.p1 });
  // Onto another booking: never.
  const clash = await put(a, { start: `${D(3)}T11:45`, force: true });
  assert.deepEqual([clash.status, clash.body.hard[0].code, clash.body.hard[0].id], [422, "taken", b]);
  // A booking doesn't block itself: longer in place is fine while it fits.
  ok(await put(a, { duration: 60, force: true }));
  assert.equal((await put(a, { duration: 91, force: true })).body.hard[0].code, "taken");
  // New services bring their length and price.
  const svc = ok(await put(a, { serviceIds: [o.s2], start: `${D(4)}T10:00` })).changes.set.appointments[0];
  assert.deepEqual([svc.serviceIds, svc.duration, svc.price], [[o.s2], 60, 90000]);
  assert.equal((await put(a, { staffId: o.p2 })).body.hard[0].code, "service_not_done");
  assert.equal((await put(a, { customerId: o.p1 })).body.code, "bad_customer");
  assert.equal((await put(a, {})).status, 400);
  assert.equal((await put(o.c1, { note: "x" })).status, 404);
});

test("moving on the calendar: a new start, a new specialist, the same rules", async () => {
  const o = await shop();
  const a = ok(await o.book({ start: `${D(3)}T10:00` }), 201).id;
  ok(await o.book({ start: `${D(3)}T12:00`, staffId: o.p2, customerId: o.c2 }), 201);
  const move = (body) => o.b.call("POST", `${o.crm}/appointments/${a}/move`, body);
  const moved = ok(await move({ start: `${D(3)}T15:00`, staffId: o.p2 })).changes.set.appointments[0];
  assert.deepEqual([moved.start, moved.staffId, moved.history[0].fromStaff, moved.history[0].toStaff], [`${D(3)}T15:00`, o.p2, o.p1, o.p2]);
  assert.equal((await move({ start: `${D(3)}T12:15` })).body.hard[0].code, "taken");
  ok(await o.b.call("PUT", `${o.crm}/staff/${o.p2}`, { breaks: [{ from: "17:00", to: "18:00" }] }));
  const soft = await move({ start: `${D(3)}T17:30` });
  assert.deepEqual([soft.status, codes(soft.body.soft)], [422, ["break"]]);
  ok(await move({ start: `${D(3)}T17:30`, force: true }));
  assert.deepEqual(ok(await move({ start: `${D(3)}T17:30` })).changes, {}, "dropped where it was");
  assert.equal((await move({})).status, 400);
  assert.equal((await move({ start: `${D(3)}T18:00`, note: "x" })).status, 400, "a move carries only the time and the specialist");
});

test("steps by kind: here only on the day, done from the day on, missed only after the start, done marks paid", async () => {
  const o = await shop();
  const future = ok(await o.book({ start: `${D(2)}T10:00` }), 201).id;
  const todayId = ok(await o.book({ start: `${D(0)}T00:00`, duration: 1, force: true }), 201).id;
  const late = ok(await o.book({ start: `${D(0)}T23:59`, duration: 1, staffId: o.p2, force: true }), 201).id;
  const step = (id, status, reason) => o.b.call("POST", `${o.crm}/appointments/${id}/step`, { status, ...(reason ? { reason } : {}) });
  const refused = async (id, status, reason) => {
    const r = await step(id, status);
    assert.deepEqual([r.status, r.body.code, r.body.hard, r.body.soft], [422, "rules", [reason], []], status);
  };
  await refused(future, "arrived", { code: "here_early", day: D(2) });
  await refused(future, "in_service", { code: "here_early", day: D(2) });
  await refused(future, "done", { code: "done_early", day: D(2) });
  await refused(future, "no_show", { code: "noshow_early", start: `${D(2)}T10:00` });
  await refused(late, "no_show", { code: "noshow_early", start: `${D(0)}T23:59` });
  assert.equal((await step(future, "nope")).body.code, "bad_step");
  assert.deepEqual(ok(await step(future, "confirmed")).changes, {}, "already there");
  // Any open step is fine at any time.
  assert.equal(ok(await step(future, "new")).changes.set.appointments[0].status, "new");
  // Today's visit: here, then done (paid), then back, then missed.
  assert.equal(ok(await step(todayId, "arrived")).changes.set.appointments[0].status, "arrived");
  const done = ok(await step(todayId, "done")).changes.set.appointments[0];
  assert.deepEqual([done.status, done.paid, done.history.map((h) => [h.type, h.from, h.to])], ["done", true, [["status", "confirmed", "arrived"], ["status", "arrived", "done"]]]);
  const unpaid = ok(await o.b.call("POST", `${o.crm}/appointments/${todayId}/pay`, { paid: false })).changes.set.appointments[0];
  assert.deepEqual([unpaid.paid, unpaid.history.at(-1).type, unpaid.history.at(-1).paid], [false, "paid", false]);
  assert.deepEqual(ok(await o.b.call("POST", `${o.crm}/appointments/${todayId}/pay`, { paid: false })).changes, {});
  assert.equal(ok(await o.b.call("POST", `${o.crm}/appointments/${todayId}/pay`, { paid: true })).changes.set.appointments[0].paid, true);
  assert.equal((await o.b.call("POST", `${o.crm}/appointments/${todayId}/pay`, {})).status, 400);
  const missed = ok(await step(todayId, "no_show", "Did not answer")).changes.set.appointments[0];
  assert.deepEqual([missed.status, missed.history.at(-1).reason], ["no_show", "Did not answer"]);
});

test("a cancelled booking frees its time; it comes back only while the time is still free", async () => {
  const o = await shop();
  const a = ok(await o.book({ start: `${D(2)}T10:00` }), 201).id;
  const step = (id, status) => o.b.call("POST", `${o.crm}/appointments/${id}/step`, { status });
  ok(await step(a, "cancelled"));
  const b = ok(await o.book({ start: `${D(2)}T10:15`, customerId: o.c2 }), 201).id;
  const back = await step(a, "confirmed");
  assert.deepEqual([back.status, back.body.hard[0].code, back.body.hard[0].id], [422, "taken", b]);
  // Cancelled bookings may sit on top of each other and be edited freely: they hold no time.
  ok(await o.b.call("PUT", `${o.crm}/appointments/${a}`, { start: `${D(2)}T10:20` }));
  ok(await step(b, "no_show").then(async (r) => (r.status === 422 ? step(b, "cancelled") : r)));
  assert.equal(ok(await step(a, "new")).changes.set.appointments[0].status, "new");
  assert.equal((await step(b, "confirmed")).body.hard[0].code, "taken");
});

test("deleting a booking is for admins", async () => {
  const o = await shop();
  const mate = await teammate(o, "agent");
  const admin = await teammate(o, "admin", "Nodira Saidova");
  const a = ok(await o.book({ start: `${D(2)}T10:00` }), 201).id;
  assert.equal((await mate.b.call("DELETE", `${o.crm}/appointments/${a}`)).status, 403);
  assert.deepEqual(ok(await admin.b.call("DELETE", `${o.crm}/appointments/${a}`)).changes, { del: { appointments: [a] } });
  assert.equal((await admin.b.call("DELETE", `${o.crm}/appointments/${a}`)).status, 404);
  // A team member books, edits, moves, changes steps and takes payment.
  const mine = ok(await o.book({ start: `${D(2)}T10:00` }, mate.b), 201);
  assert.equal(mine.changes.set.appointments[0].history.length, 0);
  ok(await mate.b.call("POST", `${o.crm}/appointments/${mine.id}/move`, { start: `${D(2)}T11:00` }));
  ok(await mate.b.call("POST", `${o.crm}/appointments/${mine.id}/pay`, { paid: true }));
  const cancelled = ok(await mate.b.call("POST", `${o.crm}/appointments/${mine.id}/step`, { status: "cancelled" })).changes.set.appointments[0];
  assert.equal(cancelled.history.at(-1).by, mate.user.name);
});

test("one workspace never sees or touches another's bookings, team or services", async () => {
  const o = await shop();
  const far = await shop();
  const a = ok(await o.book({ start: `${D(2)}T10:00` }), 201).id;
  const series = ok(await o.b.call("POST", `${o.crm}/series`, { appointmentId: a }), 201).id;
  const off = ok(await o.b.call("POST", `${o.crm}/time-off`, { start: `${D(9)}T00:00`, end: `${D(9)}T23:59` }), 201).id;
  const tries = [
    ["PUT", `/appointments/${a}`, { note: "x" }],
    ["POST", `/appointments/${a}/move`, { start: `${D(2)}T11:00` }],
    ["POST", `/appointments/${a}/step`, { status: "cancelled" }],
    ["POST", `/appointments/${a}/pay`, { paid: true }],
    ["DELETE", `/appointments/${a}`],
    ["PUT", `/staff/${o.p1}`, { name: "x" }],
    ["DELETE", `/staff/${o.p2}`],
    ["PUT", `/services/${o.s1}`, { price: 1 }],
    ["DELETE", `/services/${o.s1}`],
    ["PUT", `/time-off/${off}`, { note: "x" }],
    ["DELETE", `/time-off/${off}`],
    ["POST", "/series", { appointmentId: a }],
    ["PUT", `/series/${series}`, { from: D(9), time: "11:00" }],
    ["POST", `/series/${series}/stop`, { from: D(9) }],
  ];
  for (const [method, path, body] of tries) assert.equal((await far.b.call(method, far.crm + path, body)).status, 404, `${method} ${path}`);
  // And not through the other workspace's address either.
  assert.equal((await far.b.call("GET", `${o.crm}/snapshot`)).status, 404);
  assert.equal((await far.b.call("POST", `${o.crm}/appointments`, { customerId: o.c1, staffId: o.p1, serviceIds: [o.s1], start: `${D(3)}T10:00` })).status, 404);
  assert.equal((await far.book({ start: `${D(3)}T10:00`, staffId: o.p1 })).body.hard[0].code, "no_staff");
  assert.equal((await far.b.call("POST", `${far.crm}/booking/check`, { staffId: o.p1, serviceIds: [o.s1], start: `${D(2)}T10:00` })).body.hard[0].code, "no_staff");
  assert.deepEqual((await snap(far, "appointments,series,timeOff")).appointments, []);
  const mine = await snap(o);
  assert.equal(mine.appointments.find((x) => x.id === a).note, "", "nothing changed");
  assert.equal(mine.timeOff.length, 1);
  // Signed out: nothing.
  const res = await fetch(`${base}${o.crm}/appointments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
});

test("a team member who works only with their own bookings sees and changes only those", async () => {
  const o = await shop();
  const mate = await teammate(o, "agent");
  const m = { b: mate.b, crm: o.crm };
  ok(await o.b.call("PUT", `${o.crm}/staff/${o.p1}`, { userId: mate.user.id, ownOnly: true }));
  const mine = ok(await o.book({ start: `${D(2)}T10:00` }), 201).id;
  const theirs = ok(await o.book({ start: `${D(2)}T10:00`, staffId: o.p2, customerId: o.c2 }), 201).id;
  const theirSeries = ok(await o.b.call("POST", `${o.crm}/series`, { appointmentId: theirs, count: 2 }), 201).id;

  const s = await snap(m);
  assert.deepEqual([s.me.staffId, s.role], [o.p1, "agent"]);
  assert.deepEqual(s.appointments.map((a) => a.id), [mine]);
  assert.deepEqual(s.series, []);
  assert.equal(s.staff.length, 2, "the team itself is no secret");
  assert.deepEqual((await snap(m, "appointments")).appointments.map((a) => a.id), [mine]);
  assert.equal((await snap(o)).appointments.length, 3, "the owner sees everything");

  for (const [method, path, body] of [
    ["PUT", `/appointments/${theirs}`, { note: "x" }],
    ["POST", `/appointments/${theirs}/move`, { start: `${D(2)}T12:00` }],
    ["POST", `/appointments/${theirs}/step`, { status: "cancelled" }],
    ["POST", `/appointments/${theirs}/pay`, { paid: true }],
    ["POST", "/series", { appointmentId: theirs }],
    ["PUT", `/series/${theirSeries}`, { from: D(9), time: "12:00" }],
    ["POST", `/series/${theirSeries}/stop`, { from: D(9) }],
  ]) {
    assert.equal((await m.b.call(method, o.crm + path, body)).status, 404, `${method} ${path}`);
  }
  // They book for themselves: "anyone" means them, someone else is refused.
  assert.equal((await o.book({ start: `${D(3)}T10:00`, staffId: o.p2 }, m.b)).status, 403);
  assert.equal((await o.book({ start: `${D(2)}T10:00`, staffId: o.p2 }, m.b)).status, 403, "not a 422 that tells them about another's calendar");
  assert.equal(ok(await o.book({ start: `${D(3)}T10:00`, staffId: null }, m.b), 201).changes.set.appointments[0].staffId, o.p1);
  ok(await m.b.call("PUT", `${o.crm}/appointments/${mine}`, { note: "Mine" }));
  assert.equal((await m.b.call("POST", `${o.crm}/appointments/${mine}/move`, { staffId: o.p2 })).status, 403);
  ok(await m.b.call("POST", `${o.crm}/appointments/${mine}/move`, { start: `${D(2)}T11:00` }));
  // Their own time off only.
  assert.equal((await m.b.call("POST", `${o.crm}/time-off`, { staffId: o.p2, start: `${D(4)}T10:00`, end: `${D(4)}T10:59` })).status, 403);
  assert.equal((await m.b.call("POST", `${o.crm}/time-off`, { start: `${D(4)}T10:00`, end: `${D(4)}T10:59` })).status, 403);
  const off = ok(await m.b.call("POST", `${o.crm}/time-off`, { staffId: o.p1, start: `${D(4)}T10:00`, end: `${D(4)}T10:59` }), 201).id;
  assert.equal((await m.b.call("PUT", `${o.crm}/time-off/${off}`, { staffId: o.p2 })).status, 403);
  ok(await m.b.call("DELETE", `${o.crm}/time-off/${off}`));
  // A customer's history shows them their own visits.
  assert.deepEqual(ok(await m.b.call("GET", `${o.crm}/customers/${o.c2}/history`)).appointments, []);
  assert.equal(ok(await o.b.call("GET", `${o.crm}/customers/${o.c2}/history`)).appointments.length, 2);
  // The flag binds team members, not admins.
  ok(await o.b.call("PUT", `${o.crm}/staff/${o.p1}`, { userId: o.user.id, ownOnly: true }));
  assert.equal((await snap(o)).appointments.length, 4);
  assert.equal((await snap(m)).appointments.length, 4, "no longer linked: sees all again");
});

test("the race for one time: of two bookings sent in the same instant exactly one wins", async () => {
  const o = await shop();
  const mate = await teammate(o, "agent");
  for (let i = 0; i < 12; i++) {
    const start = `${D(2 + (i % 5))}T${String(8 + i).padStart(2, "0")}:00`;
    const [a, b] = await Promise.all([o.book({ start, duration: 40 }), o.book({ start: start.replace(":00", ":20"), duration: 40, customerId: o.c2 }, mate.b)]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 422], `round ${i}: ${JSON.stringify([a.body, b.body])}`);
    const lost = a.status === 422 ? a : b;
    const won = a.status === 201 ? a : b;
    assert.deepEqual([lost.body.code, lost.body.hard[0].code, lost.body.hard[0].id], ["rules", "taken", won.body.id]);
  }
  // Moves race too: two bookings dragged onto the same free time.
  const x = ok(await o.book({ start: `${D(8)}T08:00` }), 201).id;
  const y = ok(await o.book({ start: `${D(8)}T09:00`, customerId: o.c2 }), 201).id;
  for (let i = 0; i < 6; i++) {
    const start = `${D(8)}T${12 + i}:00`;
    const [a, b] = await Promise.all([o.b.call("POST", `${o.crm}/appointments/${x}/move`, { start }), mate.b.call("POST", `${o.crm}/appointments/${y}/move`, { start })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 422], `move round ${i}`);
    // Put the winner back out of the way.
    const winner = a.status === 200 ? x : y;
    ok(await o.b.call("POST", `${o.crm}/appointments/${winner}/move`, { start: winner === x ? `${D(8)}T08:00` : `${D(8)}T09:00` }));
  }
  const overlaps = (await query(
    `SELECT count(*)::int AS n FROM crm_appointments a JOIN crm_appointments b ON a.staff_id = b.staff_id AND a.id < b.id AND a.busy AND b.busy
       AND tsrange(a.start_at, a.start_at + make_interval(mins => a.duration)) && tsrange(b.start_at, b.start_at + make_interval(mins => b.duration))
      WHERE a.workspace_id = $1`,
    [o.ws.id]
  )).rows[0].n;
  assert.equal(overlaps, 0);
});

test("the database itself refuses a double booking, and the API answers it like the rules do", async () => {
  const o = await shop();
  const branch = (await snap(o)).branches[0].id;
  const raw = (start, duration, status = "confirmed", busy = true, staff = o.p1) =>
    query(
      `INSERT INTO crm_appointments (workspace_id, branch_id, customer_id, staff_id, service_ids, start_at, duration, status, busy) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [o.ws.id, branch, o.c1, staff, [o.s1], start, duration, status, busy]
    );
  // Straight into the table, past the server's own lock: two overlapping rows in the same instant.
  for (let i = 0; i < 8; i++) {
    const day = D(10 + i);
    const results = await Promise.allSettled([raw(`${day}T10:00`, 60), raw(`${day}T10:30`, 60), raw(`${day}T10:59`, 30)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, `round ${i}`);
    // The losers are refused by the constraint; when two wait on each other, Postgres ends one as a deadlock instead.
    for (const r of results.filter((x) => x.status === "rejected")) assert.ok((r.reason.code === "23P01" && r.reason.constraint === "crm_appointments_no_overlap") || r.reason.code === "40P01", r.reason.message);
  }
  // Back to back, another specialist and rows that hold no time are all fine.
  await raw(`${D(10)}T11:00`, 30);
  await raw(`${D(10)}T10:00`, 60, "confirmed", true, o.p2);
  await raw(`${D(10)}T10:00`, 60, "cancelled", false);
  // A visit can't run past midnight in the table either.
  await assert.rejects(raw(`${D(20)}T23:30`, 31), (e) => e.constraint === "crm_appointments_same_day");
  await assert.rejects(raw(`${D(21)}T10:00`, 1440), (e) => e.constraint === "crm_appointments_same_day");
  await raw(`${D(20)}T23:30`, 30);
  await raw(`${D(22)}T00:00`, 1440);

  // A row the rules can't see as busy (its step reads as cancelled) but the table holds as busy:
  // check() passes, the constraint fires, and the answer is still the 422 with the clashing booking.
  const hidden = (await raw(`${D(25)}T10:00`, 60, "cancelled", true)).rows[0].id;
  const r = await o.book({ start: `${D(25)}T10:30` });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.deepEqual([r.body.code, r.body.hard, r.body.soft], ["rules", [{ code: "taken", staffId: o.p1, id: hidden, from: "10:00", to: "11:00" }], []]);
  const free = ok(await o.book({ start: `${D(25)}T12:00` }), 201).id;
  const moved = await o.b.call("POST", `${o.crm}/appointments/${free}/move`, { start: `${D(25)}T10:45` });
  assert.deepEqual([moved.status, moved.body.hard[0].code, moved.body.hard[0].id], [422, "taken", hidden]);
  // The refused write left nothing behind and the workspace still works.
  assert.equal((await snap(o, "appointments")).appointments.find((a) => a.id === free).start, `${D(25)}T12:00`);
  ok(await o.book({ start: `${D(25)}T13:00` }), 201);
});

test("free times and the check, asked without saving", async () => {
  const o = await shop();
  const wd = weekday(D(3));
  ok(await o.b.call("PUT", `${o.crm}/staff/${o.p1}`, { hours: { ...ALL_DAY, [wd]: ["10:00", "13:00"] } }));
  ok(await o.b.call("PUT", `${o.crm}/staff/${o.p2}`, { hours: { ...ALL_DAY, [wd]: ["11:00", "12:00"] } }));
  const a = ok(await o.book({ start: `${D(3)}T10:30` }), 201).id;
  const slots = (qs) => o.b.call("GET", `${o.crm}/booking/slots?${qs}`);
  const one = ok(await slots(`day=${D(3)}&serviceIds=${o.s1}&staffId=${o.p1}`));
  assert.deepEqual([one.day, one.duration, one.step, one.none], [D(3), 30, 15, null]);
  assert.deepEqual(one.slots.map((s) => s.time), ["10:00", "11:00", "11:15", "11:30", "11:45", "12:00", "12:15", "12:30"]);
  assert.deepEqual(one.slots[0], { min: 600, staffId: o.p1, time: "10:00" });
  // Anyone: each time goes to the first specialist free then.
  const any = ok(await slots(`day=${D(3)}&serviceIds=${o.s1}`));
  assert.deepEqual(any.slots.filter((s) => s.staffId === o.p2).map((s) => s.time), []);
  ok(await o.b.call("PUT", `${o.crm}/staff/${o.p2}`, { hours: { ...ALL_DAY, [wd]: ["10:00", "12:00"] } }));
  assert.deepEqual(ok(await slots(`day=${D(3)}&serviceIds=${o.s1}`)).slots.filter((s) => s.staffId === o.p2).map((s) => s.time), ["10:15", "10:30", "10:45"]);
  // The booking being moved doesn't block itself; a longer visit has fewer starts.
  assert.equal(ok(await slots(`day=${D(3)}&serviceIds=${o.s1}&staffId=${o.p1}&ignoreId=${a}`)).slots.length, 11);
  assert.deepEqual(ok(await slots(`day=${D(3)}&serviceIds=${o.s1},${o.s2}&staffId=${o.p1}`)).slots.map((s) => s.time), ["11:00", "11:15", "11:30"]);
  assert.deepEqual(ok(await slots(`day=${D(3)}&serviceIds=${o.s1}&staffId=${o.p1}&duration=120`)).slots.map((s) => s.time), ["11:00"]);
  // Why there are none.
  assert.deepEqual(ok(await slots(`day=${D(-1)}&serviceIds=${o.s1}`)).none, { code: "day_passed" });
  assert.deepEqual(ok(await slots(`day=${D(40)}&serviceIds=${o.s1}`)).none, { code: "max_days", days: 30 });
  assert.deepEqual(ok(await slots(`day=${D(3)}&serviceIds=${o.s2}&staffId=${o.p2}`)).none, { code: "nobody_does", staffId: o.p2 });
  ok(await o.b.call("PUT", `${o.crm}/staff/${o.p1}`, { hours: { ...ALL_DAY, [wd]: ["10:00", "11:00"] } }));
  assert.deepEqual(ok(await slots(`day=${D(3)}&serviceIds=${o.s2}`)).none, { code: "full" });
  assert.equal((await slots(`day=${D(3)}`)).status, 400);
  assert.equal((await slots(`day=soon&serviceIds=${o.s1}`)).status, 400);

  // The check: clean, taken, and as a customer would be judged (the grid).
  const ask = (body) => o.b.call("POST", `${o.crm}/booking/check`, { serviceIds: [o.s1], ...body }).then((r) => ok(r));
  assert.deepEqual(await ask({ staffId: o.p2, start: `${D(3)}T10:20` }), { staffId: o.p2, duration: 30, hard: [], soft: [], ok: true, canForce: false });
  const grid = await ask({ staffId: o.p2, start: `${D(3)}T10:20`, by: "customer" });
  assert.deepEqual([grid.soft, grid.ok, grid.canForce], [[{ code: "off_grid", step: 15 }], false, false]);
  const taken = await ask({ staffId: o.p1, start: `${D(3)}T10:45` });
  assert.deepEqual([codes(taken.hard), taken.ok, taken.canForce], [["taken"], false, false]);
  assert.deepEqual((await ask({ staffId: o.p1, start: `${D(3)}T10:45`, ignoreId: a })).hard, []);
  assert.equal((await ask({ staffId: null, start: `${D(3)}T10:30` })).staffId, o.p2, "anyone: whoever is free");
  assert.equal((await snap(o, "appointments")).appointments.length, 1, "asking saves nothing");
});

test("repeat bookings: the next visits are booked, a day that can't be is skipped with its reasons", async () => {
  const o = await shop();
  const first = D(2);
  const days = seriesDays({ startDay: first, every: 1, weekdays: [weekday(first)] }, first, D(30));
  assert.deepEqual(days.length, 5);
  // Someone else already has the third week's time.
  const other = ok(await o.book({ start: `${days[2]}T10:15`, customerId: o.c2 }), 201).id;
  const anchor = ok(await o.book({ start: `${first}T10:00`, note: "Weekly", price: 40000 }), 201).id;
  const r = ok(await o.b.call("POST", `${o.crm}/series`, { appointmentId: anchor }), 201);
  assert.equal(r.created.length, 3);
  assert.deepEqual(r.skipped, [{ day: days[2], hard: [{ code: "taken", staffId: o.p1, id: other, from: "10:15", to: "10:45" }], soft: [] }]);
  const series = r.changes.set.series[0];
  assert.deepEqual(
    { ...series, branchId: "" },
    { id: r.id, customerId: o.c1, staffId: o.p1, serviceIds: [o.s1], time: "10:00", duration: 30, price: 40000, source: "", note: "Weekly", fields: {}, every: 1, weekdays: [weekday(first)], startDay: first, until: null, count: null, through: D(30), skipped: r.skipped, branchId: "" }
  );
  const visits = r.changes.set.appointments;
  assert.deepEqual(visits.map((a) => [a.start, a.seriesId, a.seriesDay, a.status, a.price, a.note]), [days[0], days[1], days[3], days[4]].map((d) => [`${d}T10:00`, r.id, d, "confirmed", 40000, "Weekly"]));
  const s = await snap(o);
  assert.deepEqual(s.series, [series]);
  assert.equal(s.appointments.filter((a) => a.seriesId === r.id).length, 4);
  // A booking repeats once; a cancelled one can't start a series; the weekdays must include its day.
  assert.equal((await o.b.call("POST", `${o.crm}/series`, { appointmentId: anchor })).body.code, "in_series");
  assert.equal((await o.b.call("POST", `${o.crm}/series`, { appointmentId: other, weekdays: [(weekday(days[2]) + 1) % 7] })).body.code, "bad_weekdays");
  assert.equal((await o.b.call("POST", `${o.crm}/series`, { appointmentId: other, until: days[2] })).body.code, "bad_until");
  assert.equal((await o.b.call("POST", `${o.crm}/series`, { appointmentId: other, until: D(20), count: 3 })).status, 400);
  ok(await o.b.call("POST", `${o.crm}/appointments/${other}/step`, { status: "cancelled" }));
  assert.equal((await o.b.call("POST", `${o.crm}/series`, { appointmentId: other })).body.code, "booking_closed");

  // Soft reasons skip a day too: nothing in a series is forced.
  ok(await o.b.call("POST", `${o.crm}/time-off`, { start: `${D(10)}T00:00`, end: `${D(10)}T23:59`, note: "Holiday" }), 201);
  const b = ok(await o.book({ start: `${D(3)}T15:00`, staffId: o.p2 }), 201).id;
  const every2 = ok(await o.b.call("POST", `${o.crm}/series`, { appointmentId: b, every: 2, count: 3 }), 201);
  assert.deepEqual(every2.changes.set.appointments.map((a) => a.start), [`${D(3)}T15:00`, `${D(17)}T15:00`]);
  assert.deepEqual(every2.skipped, []);
  const c = ok(await o.book({ start: `${D(3)}T18:00`, staffId: o.p2 }), 201).id;
  const until = ok(await o.b.call("POST", `${o.crm}/series`, { appointmentId: c, until: D(17) }), 201);
  assert.deepEqual(until.changes.set.appointments.map((a) => a.start), [`${D(3)}T18:00`, `${D(17)}T18:00`]);
  assert.deepEqual(until.skipped.map((x) => [x.day, codes(x.hard), codes(x.soft)]), [[D(10), [], ["closed"]]]);
});

test("repeat bookings: only this one, this and all later ones, and stopping", async () => {
  const o = await shop();
  const first = D(2);
  const days = seriesDays({ startDay: first, every: 1, weekdays: [weekday(first)] }, first, D(30));
  const anchor = ok(await o.book({ start: `${first}T10:00` }), 201).id;
  const made = ok(await o.b.call("POST", `${o.crm}/series`, { appointmentId: anchor }), 201);
  const [, v1, v2, v3, v4] = made.changes.set.appointments.map((a) => a.id);
  const sid = made.id;
  // Only this one: an ordinary edit, the series doesn't notice.
  const single = ok(await o.b.call("PUT", `${o.crm}/appointments/${v1}`, { start: `${days[1]}T16:00`, note: "Later this week" })).changes.set.appointments[0];
  assert.deepEqual([single.start, single.seriesId, single.seriesDay], [`${days[1]}T16:00`, sid, days[1]]);
  // Only this one, cancelled.
  ok(await o.b.call("POST", `${o.crm}/appointments/${v2}/step`, { status: "cancelled" }));

  // This and all later ones, from the fourth visit: a new time and specialist. One of the days is taken there.
  const blocker = ok(await o.book({ start: `${days[4]}T12:00`, staffId: o.p2, customerId: o.c2 }), 201).id;
  const changed = ok(await o.b.call("PUT", `${o.crm}/series/${sid}`, { from: days[3], time: "12:00", staffId: o.p2, price: 60000 }));
  assert.deepEqual(changed.moved, [v3]);
  assert.deepEqual([changed.created, changed.removed], [[], []]);
  assert.deepEqual(changed.skipped, [{ day: days[4], id: v4, kept: true, hard: [{ code: "taken", staffId: o.p2, id: blocker, from: "12:00", to: "12:30" }], soft: [] }]);
  const after = await snap(o);
  const byId = Object.fromEntries(after.appointments.map((a) => [a.id, a]));
  assert.deepEqual([byId[v3].start, byId[v3].staffId, byId[v3].price, byId[v3].history.at(-1).type], [`${days[3]}T12:00`, o.p2, 60000, "moved"]);
  assert.deepEqual([byId[v4].start, byId[v4].staffId, byId[v4].price], [`${days[4]}T10:00`, o.p1, 50000], "the visit that couldn't move stays as it was");
  assert.deepEqual([byId[anchor].start, byId[v1].start, byId[v2].status], [`${first}T10:00`, `${days[1]}T16:00`, "cancelled"], "earlier visits are untouched");
  assert.deepEqual([after.series[0].time, after.series[0].staffId, after.series[0].startDay, after.series[0].skipped.length], ["12:00", o.p2, days[3], 1]);

  // This and all later ones, from the second visit: another weekday. The moved one snaps to the pattern, the
  // cancelled one stays cancelled, days that left the pattern are removed, new days are booked.
  const wd = (weekday(first) + 1) % 7;
  const shifted = ok(await o.b.call("PUT", `${o.crm}/series/${sid}`, { from: days[1], weekdays: [wd], time: "09:00", staffId: o.p1 }));
  assert.deepEqual([...shifted.removed].sort(), [v1, v3, v4].sort());
  const newDays = seriesDays({ startDay: days[1], every: 1, weekdays: [wd] }, days[1], D(30));
  assert.deepEqual(shifted.changes.set.appointments.map((a) => [a.start, a.staffId, a.seriesDay]), newDays.map((d) => [`${d}T09:00`, o.p1, d]));
  assert.equal(shifted.created.length, newDays.length);
  assert.deepEqual(shifted.changes.del.appointments.sort(), [v1, v3, v4].sort());
  assert.equal((await snap(o)).appointments.find((a) => a.id === v2).status, "cancelled");

  // Details only (price, note): nothing is re-checked or moved.
  const priced = ok(await o.b.call("PUT", `${o.crm}/series/${sid}`, { from: newDays[1], price: 70000, note: "Regular" }));
  assert.deepEqual([priced.moved, priced.created, priced.removed, priced.skipped], [[], [], [], []]);
  assert.deepEqual(priced.changes.set.appointments.map((a) => [a.price, a.note]), newDays.slice(1).map(() => [70000, "Regular"]));

  // Stop from the third new visit on: later visits are cancelled (the record stays), the series ends the day before.
  const stop = ok(await o.b.call("POST", `${o.crm}/series/${sid}/stop`, { from: newDays[2], reason: "Moved away" }));
  assert.equal(stop.cancelled.length, newDays.length - 2);
  assert.deepEqual(stop.changes.set.appointments.map((a) => [a.status, a.history.at(-1).reason]), newDays.slice(2).map(() => ["cancelled", "Moved away"]));
  assert.equal(stop.changes.set.series[0].until, addDays(newDays[2], -1));
  assert.equal((await o.b.call("PUT", `${o.crm}/series/${sid}`, { from: newDays[2], time: "08:00" })).body.code, "series_ended");
  assert.equal((await o.b.call("PUT", `${o.crm}/series/${sid}`, { from: newDays[0] })).status, 400);
  // The freed times can be booked by someone else.
  ok(await o.book({ start: `${newDays[2]}T09:00`, customerId: o.c2 }), 201);
});

test("repeat bookings: the daily job books the days that come into view", async () => {
  const o = await shop();
  const anchor = ok(await o.book({ start: `${D(1)}T10:00` }), 201).id;
  const made = ok(await o.b.call("POST", `${o.crm}/series`, { appointmentId: anchor }), 201);
  const before = made.changes.set.appointments.length;
  const counted = ok(await o.b.call("POST", `${o.crm}/series`, { appointmentId: ok(await o.book({ start: `${D(1)}T12:00` }), 201).id, count: 6 }), 201);
  const queued = (await query("SELECT count(*)::int AS n FROM jobs WHERE kind = 'crm_series_extend' AND status = 'queued' AND run_at > now() + interval '23 hours'")).rows[0].n;
  assert.equal(queued, 1, "one daily job waits, however many series there are");
  assert.equal(await extendAll(), 0, "nothing new is in view yet");

  // The business lets customers book 60 days ahead now: the next run fills the new days.
  await o.rules({ maxDays: 60 });
  ok(await o.book({ start: `${D(43)}T10:00`, customerId: o.c2, staffId: o.p1 }), 201);
  await query("UPDATE jobs SET run_at = now() WHERE kind = 'crm_series_extend'");
  await drainJobs();
  const s = await snap(o);
  const mine = s.appointments.filter((a) => a.seriesId === made.id);
  const days = seriesDays({ startDay: D(1), every: 1, weekdays: [weekday(D(1))] }, D(1), D(60));
  assert.deepEqual(mine.map((a) => dayOf(a.start)), days.filter((d) => d !== D(43)));
  assert.ok(mine.length > before);
  // Each visit, the job's too, says who made it: the person who made the series.
  assert.deepEqual([...new Set(mine.map((a) => JSON.stringify(a.createdBy)))], [JSON.stringify({ by: o.user.name, byId: o.user.id })]);
  const row = s.series.find((x) => x.id === made.id);
  assert.deepEqual([row.through, row.skipped.map((x) => [x.day, codes(x.hard)])], [D(60), [[D(43), ["taken"]]]]);
  // The counted series got exactly its six visits and is closed.
  assert.equal(s.appointments.filter((a) => a.seriesId === counted.id).length, 6);
  assert.equal((await query("SELECT until = through AS closed FROM crm_series WHERE id = $1", [counted.id])).rows[0].closed, true);
  // Running again books nothing twice, and tomorrow's run is waiting.
  assert.equal(await extendAll(), 0);
  assert.equal((await query("SELECT count(*)::int AS n FROM jobs WHERE kind = 'crm_series_extend' AND status = 'queued' AND run_at > now()")).rows[0].n, 1);
  assert.equal((await snap(o)).appointments.length, s.appointments.length);
});

test("who made a booking: the team member by name, and a booking from before it was kept reads as unknown", async () => {
  const o = await shop();
  const mate = await teammate(o, "agent", "Dilshod Usmonov");
  const a = ok(await o.book({ start: `${D(2)}T10:00` }, mate.b), 201).changes.set.appointments[0];
  assert.deepEqual([a.createdBy, a.history], [{ by: "Dilshod Usmonov", byId: mate.user.id }, []]);
  // Kept on the booking: it stays when someone else edits it.
  const edited = ok(await o.b.call("PUT", `${o.crm}/appointments/${a.id}`, { note: "Window seat" })).changes.set.appointments[0];
  assert.deepEqual(edited.createdBy, a.createdBy);
  // A booking stored before this was kept has nobody on it: absent means unknown.
  await query("UPDATE crm_appointments SET creator = NULL WHERE id = $1", [a.id]);
  assert.equal((await snap(o, "appointments")).appointments.find((x) => x.id === a.id).createdBy, null);
});

test("repeat bookings: a specialist who only a series names can be deleted; its visits stay as ordinary bookings", async () => {
  const o = await shop();
  const first = D(2);
  const days = seriesDays({ startDay: first, every: 1, weekdays: [weekday(first)] }, first, D(30));
  const anchor = ok(await o.book({ start: `${first}T10:00`, serviceIds: [o.s2] }), 201).id;
  const made = ok(await o.b.call("POST", `${o.crm}/series`, { appointmentId: anchor }), 201);
  // Bek doesn't do the colour: every visit from the second on stays with Aziz, and the series names Bek.
  const changed = ok(await o.b.call("PUT", `${o.crm}/series/${made.id}`, { from: days[1], staffId: o.p2 }));
  assert.deepEqual([changed.moved, changed.created], [[], []]);
  assert.ok(changed.skipped.every((x) => x.kept && codes(x.hard).includes("service_not_done")));
  const del = ok(await o.b.call("DELETE", `${o.crm}/staff/${o.p2}`));
  assert.deepEqual(del.changes.del, { staff: [o.p2], series: [made.id] });
  assert.equal(del.changes.set.appointments.length, days.length);
  assert.ok(del.changes.set.appointments.every((a) => a.seriesId === null && a.seriesDay === null && a.staffId === o.p1));
  const s = await snap(o);
  assert.deepEqual([s.series, s.appointments.filter((a) => a.seriesId).length, s.appointments.length], [[], 0, days.length]);
});

test("removing a step moves its bookings; a step, a source or a customer in use is guarded", async () => {
  const o = await shop();
  const stages = (await snap(o)).apptStages;
  ok(await o.b.call("PUT", `${o.crm}/settings`, { apptStages: [stages[0], stages[1], { id: "reminded", name: "Reminded", tone: "blue", kind: "booked" }, ...stages.slice(2)] }));
  const a = ok(await o.book({ start: `${D(2)}T10:00`, source: "phone" }), 201).id;
  const b = ok(await o.book({ start: `${D(2)}T11:00` }), 201).id;
  ok(await o.b.call("POST", `${o.crm}/appointments/${a}/step`, { status: "reminded" }));
  const noMove = await o.b.call("PUT", `${o.crm}/settings`, { apptStages: stages });
  assert.deepEqual([noMove.status, noMove.body.code, noMove.body.id, noMove.body.count], [409, "stage_needs_move", "reminded", 1]);
  const kind = await o.b.call("PUT", `${o.crm}/settings`, { apptStages: [stages[0], { ...stages[1], kind: "pending" }, { id: "reminded", name: "Reminded", tone: "blue", kind: "booked" }, ...stages.slice(2)] });
  assert.deepEqual([kind.status, kind.body.code, kind.body.id], [409, "stage_in_use", "confirmed"]);
  const moved = ok(await o.b.call("PUT", `${o.crm}/settings`, { apptStages: stages, moves: { apptStages: [{ from: "reminded", to: "confirmed" }] } }));
  assert.deepEqual(moved.changes.set.appointments.map((x) => [x.id, x.status]), [[a, "confirmed"]]);
  assert.deepEqual((await snap(o, "appointments")).appointments.map((x) => x.status), ["confirmed", "confirmed"]);
  // The time is still held after the move.
  assert.equal((await o.book({ start: `${D(2)}T10:00`, customerId: o.c2 })).body.hard[0].code, "taken");

  // A source a booking came from can't be removed.
  const sources = (await snap(o)).sources;
  const src = await o.b.call("PUT", `${o.crm}/settings`, { sources: sources.filter((x) => x.id !== "phone") });
  assert.deepEqual([src.status, src.body.code, src.body.id, src.body.count], [409, "in_use", "phone", 1]);
  // A customer with bookings can't be deleted; their history lists them, newest first.
  const del = await o.b.call("DELETE", `${o.crm}/customers/${o.c1}`);
  assert.deepEqual([del.status, del.body.code, del.body.uses], [409, "customer_in_use", { appointments: 2 }]);
  const history = ok(await o.b.call("GET", `${o.crm}/customers/${o.c1}/history`));
  assert.deepEqual(history.appointments.map((x) => x.id), [b, a]);
  ok(await o.b.call("DELETE", `${o.crm}/customers/${o.c2}`));
});

test("live updates: other open screens hear which part of the snapshot changed", async () => {
  const o = await shop();
  const far = await shop();
  const mine = await openStream(`${o.crm}/stream`, o.b.cookie);
  const other = await openStream(`${far.crm}/stream`, far.b.cookie);
  try {
    await mine.next((e) => e.event === "ready", 2000);
    const heard = async (key) => assert.ok(await mine.next((e) => e.event === "crm" && e.data.k.includes(key)), `"${key}" announced`);
    const a = ok(await o.book({ start: `${D(2)}T10:00` }), 201).id;
    await heard("appointments");
    ok(await o.b.call("POST", `${o.crm}/series`, { appointmentId: a, count: 2 }), 201);
    await heard("series");
    ok(await o.b.call("POST", `${o.crm}/time-off`, { start: `${D(9)}T00:00`, end: `${D(9)}T23:59` }), 201);
    await heard("timeOff");
    ok(await o.b.call("PUT", `${o.crm}/staff/${o.p2}`, { tone: "t4" }));
    await heard("staff");
    ok(await o.b.call("PUT", `${o.crm}/services/${o.s1}`, { price: 55000 }));
    await heard("services");
    assert.equal(await other.next((e) => e.event === "crm", 400), null, "another workspace hears nothing");
  } finally {
    mine.close();
    other.close();
  }
});

/* ───── Found in review: each test failed before its fix ───── */

const WORK = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, ["10:00", "20:00"]]));
const seriesRows = async (id) => (await query(`SELECT id, staff_id AS "staffId", to_char(series_day, 'YYYY-MM-DD') AS day, to_char(start_at, 'HH24:MI') AS time, status FROM crm_appointments WHERE series_id = $1 ORDER BY series_day`, [id])).rows;

test("review: a booking brought back is judged by every rule again, unless it still has the time it had when it closed", async () => {
  const o = await shop();
  await o.rules({ minNotice: 0 });
  const step = (id, status, extra) => o.b.call("POST", `${o.crm}/appointments/${id}/step`, { status, ...extra });
  const move = (id, start) => o.b.call("POST", `${o.crm}/appointments/${id}/move`, { start }).then((r) => ok(r));
  // A visit of today that was marked missed by mistake comes back: it was booked already.
  const today = ok(await o.book({ start: `${D(0)}T00:00`, duration: 1, staffId: o.p2, force: true }), 201).id;
  ok(await step(today, "no_show"));
  ok(await step(today, "done"));
  ok(await step(today, "no_show"));
  // Moved while missed, the same time is no longer the time it had: time_passed counts again.
  await move(today, `${D(0)}T00:05`);
  const moved = await step(today, "done");
  assert.deepEqual([moved.status, codes(moved.body.hard), codes(moved.body.soft)], [422, [], ["time_passed"]]);
  // Moved back to the time it had, it may come back again.
  await move(today, `${D(0)}T00:00`);
  ok(await step(today, "done"));

  // Aziz works 10:00 to 20:00, and the business doesn't let anyone pass its rules.
  ok(await o.b.call("PUT", `${o.crm}/staff/${o.p1}`, { hours: WORK }));
  await o.rules({ minNotice: 0, override: false });
  const a = ok(await o.book({ start: `${D(2)}T10:00` }), 201).id;
  assert.deepEqual(codes((await o.b.call("POST", `${o.crm}/appointments/${a}/move`, { start: `${D(2)}T03:00`, force: true })).body.soft), ["outside_hours"]);
  // Cancelled, moved to 03:00 (it holds no time, so the move is fine), then brought back: the hours count.
  ok(await step(a, "cancelled"));
  await move(a, `${D(2)}T03:00`);
  const back = await step(a, "confirmed");
  assert.deepEqual([back.status, back.body.code, codes(back.body.hard), codes(back.body.soft), back.body.override], [422, "rules", [], ["outside_hours"], false]);
  assert.equal((await step(a, "confirmed", { force: true })).status, 422, "force can't pass the rules with override off");
  await o.rules({ minNotice: 0, override: true });
  const forced = ok(await step(a, "confirmed", { force: true }));
  assert.deepEqual([forced.changes.set.appointments[0].start, forced.changes.set.appointments[0].status, codes(forced.forced)], [`${D(2)}T03:00`, "confirmed", ["outside_hours"]]);
  // Moved far past maxDays, or into a past day, while cancelled.
  const b = ok(await o.book({ start: `${D(3)}T10:00` }), 201).id;
  ok(await step(b, "cancelled"));
  await move(b, `${D(400)}T10:00`);
  assert.deepEqual(codes((await step(b, "confirmed")).body.soft), ["max_days"]);
  await move(b, `${D(-3)}T10:00`);
  assert.deepEqual(codes((await step(b, "confirmed")).body.hard), ["day_passed"]);
  assert.equal((await step(b, "confirmed", { force: true })).status, 422, "a hard reason never passes");
  assert.equal((await snap(o, "appointments")).appointments.find((x) => x.id === b).status, "cancelled");
});

test("review: a member who works only with their own bookings asks the rules only about their own calendar", async () => {
  const o = await shop();
  const mate = await teammate(o, "agent");
  ok(await o.b.call("PUT", `${o.crm}/staff/${o.p1}`, { userId: mate.user.id, ownOnly: true }));
  ok(await o.book({ start: `${D(2)}T12:00`, staffId: o.p2 }), 201);
  const ask = (body) => mate.b.call("POST", `${o.crm}/booking/check`, { serviceIds: [o.s1], start: `${D(2)}T12:00`, ...body });
  assert.equal((await ask({ staffId: o.p2 })).status, 403, "another's calendar is not theirs to read");
  assert.deepEqual([ok(await ask({ staffId: null })).staffId, ok(await ask({})).staffId, ok(await ask({ staffId: o.p1 })).ok], [o.p1, o.p1, true]);
  const slots = (q) => mate.b.call("GET", `${o.crm}/booking/slots?day=${D(2)}&serviceIds=${o.s1}${q}`);
  assert.equal((await slots(`&staffId=${o.p2}`)).status, 403);
  const free = ok(await slots(""));
  assert.ok(free.slots.length && free.slots.every((x) => x.staffId === o.p1), "anyone means them");
  // The owner still asks about anyone.
  assert.equal(ok(await o.b.call("POST", `${o.crm}/booking/check`, { staffId: o.p2, serviceIds: [o.s1], start: `${D(2)}T12:00` })).hard[0].code, "taken");
});

test("review: a member's series never touches a visit someone moved to another specialist", async () => {
  const o = await shop();
  await o.rules({ minNotice: 0 });
  const mate = await teammate(o, "agent");
  ok(await o.b.call("PUT", `${o.crm}/staff/${o.p1}`, { userId: mate.user.id, ownOnly: true }));
  const anchor = ok(await o.book({ start: `${D(1)}T10:00` }), 201).id;
  const made = ok(await o.b.call("POST", `${o.crm}/series`, { appointmentId: anchor }), 201);
  const target = made.created[0];
  ok(await o.b.call("POST", `${o.crm}/appointments/${target}/move`, { staffId: o.p2 }));
  assert.equal((await mate.b.call("PUT", `${o.crm}/appointments/${target}`, { note: "x" })).status, 404);
  const touched = (r) => [...(r.changes.set?.appointments || []).map((x) => x.id), ...(r.changes.del?.appointments || [])];

  const time = ok(await mate.b.call("PUT", `${o.crm}/series/${made.id}`, { from: D(1), time: "11:00" }));
  assert.ok(time.moved.length > 0 && !time.moved.includes(target) && !touched(time).includes(target));
  // Another weekday: their visits leave the pattern, the one Bek has stays.
  const wd = (weekday(D(1)) + 1) % 7;
  const shifted = ok(await mate.b.call("PUT", `${o.crm}/series/${made.id}`, { from: D(1), weekdays: [wd] }));
  assert.ok(shifted.removed.length > 0 && !shifted.removed.includes(target) && !touched(shifted).includes(target));
  const stop = ok(await mate.b.call("POST", `${o.crm}/series/${made.id}/stop`, { from: D(1) }));
  assert.ok(stop.cancelled.length > 0 && !stop.cancelled.includes(target) && !touched(stop).includes(target));
  const row = (await seriesRows(made.id)).find((x) => x.id === target);
  assert.deepEqual([row.staffId, row.time, row.status], [o.p2, "10:00", "confirmed"]);
});

test("review: after maxDays is lowered, changing a series keeps its visits further ahead, and the job books what is missing", async () => {
  const o = await shop();
  await o.rules({ minNotice: 0, maxDays: 60 });
  const anchor = ok(await o.book({ start: `${D(1)}T10:00` }), 201).id;
  const made = ok(await o.b.call("POST", `${o.crm}/series`, { appointmentId: anchor }), 201);
  const all = seriesDays({ startDay: D(1), every: 1, weekdays: [weekday(D(1))] }, D(1), D(60));
  assert.equal(made.created.length, all.length - 1);
  await o.rules({ minNotice: 0, maxDays: 30 });
  // Details only: nothing is removed.
  const note = ok(await o.b.call("PUT", `${o.crm}/series/${made.id}`, { from: D(1), note: "Bring a towel" }));
  assert.deepEqual([note.removed, note.created, note.skipped], [[], [], []]);
  assert.deepEqual((await seriesRows(made.id)).map((x) => x.day), all);
  // A new time: the visits past the new horizon move too (they were booked already), none is lost.
  const later = ok(await o.b.call("PUT", `${o.crm}/series/${made.id}`, { from: D(1), time: "11:00" }));
  assert.deepEqual([later.removed, later.skipped], [[], []]);
  assert.deepEqual((await seriesRows(made.id)).map((x) => [x.day, x.time]), all.map((d) => [d, "11:00"]));
  // A second weekday: its days up to the horizon are booked now, the ones past it by the job, once in view.
  const wd2 = (weekday(D(1)) + 3) % 7;
  const two = ok(await o.b.call("PUT", `${o.crm}/series/${made.id}`, { from: D(1), weekdays: [weekday(D(1)), wd2] }));
  assert.deepEqual([two.removed, two.skipped], [[], []]);
  const both = seriesDays({ startDay: D(1), every: 1, weekdays: [weekday(D(1)), wd2] }, D(1), D(60));
  assert.deepEqual(two.created.length, both.filter((d) => d <= D(30) && !all.includes(d)).length);
  await o.rules({ minNotice: 0, maxDays: 60 });
  await extendAll();
  assert.deepEqual((await seriesRows(made.id)).map((x) => x.day), both, "every day once, none twice");
  const row = (await snap(o, "series")).series[0];
  assert.deepEqual([row.through, row.skipped], [D(60), []]);
});

test("review: editing a cancelled booking into a time that can't be stored is a 422, not a 500", async () => {
  const o = await shop();
  const a = ok(await o.book({ start: `${D(1)}T10:00` }), 201).id;
  ok(await o.b.call("POST", `${o.crm}/appointments/${a}/step`, { status: "cancelled" }));
  const late = await o.b.call("PUT", `${o.crm}/appointments/${a}`, { start: `${D(1)}T23:30`, duration: 60 });
  assert.deepEqual([late.status, late.body.code, codes(late.body.hard)], [422, "rules", ["ends_next_day"]]);
  const long1 = (await o.post("/services", { name: "Long", duration: 1000 })).id;
  const long2 = (await o.post("/services", { name: "Longer", duration: 1000 })).id;
  ok(await o.b.call("PUT", `${o.crm}/staff/${o.p1}`, { serviceIds: [o.s1, o.s2, long1, long2] }));
  const long = await o.b.call("PUT", `${o.crm}/appointments/${a}`, { start: `${D(1)}T00:00`, serviceIds: [long1, long2] });
  assert.deepEqual([long.status, codes(long.body.hard)], [422, ["ends_next_day"]]);
  // The same for a booking that holds its time.
  const b = ok(await o.book({ start: `${D(2)}T10:00` }), 201).id;
  assert.deepEqual(codes((await o.b.call("PUT", `${o.crm}/appointments/${b}`, { start: `${D(2)}T23:30`, duration: 60, force: true })).body.hard), ["ends_next_day"]);
});

test("review: a series is changed only from one of its own days", async () => {
  const o = await shop();
  await o.rules({ minNotice: 0, maxDays: 60 });
  const anchor = ok(await o.book({ start: `${D(1)}T10:00` }), 201).id;
  const made = ok(await o.b.call("POST", `${o.crm}/series`, { appointmentId: anchor, every: 2 }), 201);
  const before = (await seriesRows(made.id)).map((x) => x.day);
  // A day between two visits, and a day before the series began.
  for (const from of [D(8), D(-6), D(0)]) {
    const r = await o.b.call("PUT", `${o.crm}/series/${made.id}`, { from, note: "x" });
    assert.deepEqual([r.status, r.body.code], [400, "bad_from"], from);
  }
  assert.deepEqual((await seriesRows(made.id)).map((x) => x.day), before);
  // One of its days is fine, and so is one whose visit was deleted.
  ok(await o.b.call("DELETE", `${o.crm}/appointments/${made.created[0]}`));
  ok(await o.b.call("PUT", `${o.crm}/series/${made.id}`, { from: before[1], note: "x" }));
  ok(await o.b.call("PUT", `${o.crm}/series/${made.id}`, { from: before[2], note: "y" }));
  const late = ok(await o.book({ start: `${D(15)}T12:00` }), 201).id;
  const s2 = ok(await o.b.call("POST", `${o.crm}/series`, { appointmentId: late }), 201);
  assert.equal((await o.b.call("PUT", `${o.crm}/series/${s2.id}`, { from: D(1), note: "x" })).body.code, "bad_from");
  assert.equal((await seriesRows(s2.id)).every((x) => x.day >= D(15)), true);
});

test("review: a customer with a series can't be deleted, even once its visits are gone", async () => {
  const o = await shop();
  const anchor = ok(await o.book({ start: `${D(1)}T10:00`, customerId: o.c2 }), 201).id;
  const made = ok(await o.b.call("POST", `${o.crm}/series`, { appointmentId: anchor }), 201);
  for (const id of [anchor, ...made.created]) ok(await o.b.call("DELETE", `${o.crm}/appointments/${id}`));
  const del = await o.b.call("DELETE", `${o.crm}/customers/${o.c2}`);
  assert.deepEqual([del.status, del.body.code, del.body.uses], [409, "customer_in_use", { series: 1 }]);
  assert.equal((await snap(o, "series")).series.length, 1);
});
