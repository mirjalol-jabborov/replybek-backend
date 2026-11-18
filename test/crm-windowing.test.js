// What a screen downloads follows what it shows, not how old the business is: the snapshot's window
// (?recent=1) and its edges, the plain snapshot answering as before, older rows page by page, rows
// by id with deleted ones gone, live updates that name the rows (and "many"), the sidebar's and
// Today's counts, customers linked to the window and found by search, and tenancy, branch limits
// and own-only specialists on every new way in.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { crmOwner, teammate, query, base } from "./helpers/setup.js";
import { nowIn, addDays, dayOf } from "../src/crm/shared/time.js";

const TZ = "Asia/Tashkent";
const today = () => dayOf(nowIn(TZ, new Date()));
const D = (n) => addDays(today(), n);
const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, ["00:00", "24:00"]]));
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const refused = (r, status, code) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.equal(r.body.code, code, JSON.stringify(r.body));
  return r.body;
};
const ids = (rows) => rows.map((r) => r.id);
const sorted = (list) => [...list].sort();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A shop and salon in one: two branches, a specialist at each, a product with stock at both, a customer. */
async function business() {
  const o = await crmOwner();
  const call = (method, path, body, b = o.b) => b.call(method, o.crm + path, body);
  const snap = async (q = "", b = o.b) => ok(await b.call("GET", `${o.crm}/snapshot${q}`));
  ok(await call("PUT", "/settings", { modules: { booking: true, store: true } }));
  const A = (await snap("?only=branches")).branches[0].id;
  const B = ok(await call("POST", "/branches", { name: "Chilonzor" }), 201).id;
  const s1 = ok(await call("POST", "/services", { name: "Haircut", duration: 30, price: 50000 }), 201).id;
  const pa = ok(await call("POST", "/staff", { name: "Aziz", hours: ALL_DAY, serviceIds: [s1] }), 201).id;
  const pb = ok(await call("POST", "/staff", { name: "Bek", hours: ALL_DAY, serviceIds: [s1], branchId: B }), 201).id;
  const c1 = ok(await call("POST", "/customers", { name: "Jasur Karimov", phone: "+998901234567", telegram: "jasur_k" }), 201).id;
  const product = ok(await call("POST", "/products", { name: "Roses", sku: `R${Math.random().toString(36).slice(2, 9)}`, price: 100000, opening: 100 }), 201).changes.set.products[0];
  ok(await call("POST", "/stock/receive", { lines: [{ productId: product.id, qty: 50 }], branchId: B }));
  const book = (body, b) => call("POST", "/appointments", { customerId: c1, serviceIds: [s1], staffId: pa, start: `${D(2)}T10:00`, ...body }, b);
  const order = (body, b) => call("POST", "/orders", { customerId: c1, delivery: { type: "pickup" }, lines: [{ productId: product.id, qty: 1 }], ...body }, b);
  return { ...o, call, snap, A, B, s1, pa, pb, c1, product, book, order };
}

/** Moves a booking to a moment (and step) directly, as if it was made long ago. */
const placeBooking = (id, start, status = null) =>
  query("UPDATE crm_appointments SET start_at = $2::timestamp, status = COALESCE($3, status) WHERE id = $1", [id, start, status]);
/** An order made `madeDaysAgo` days ago and last changed at `changed` (SQL, on the business's clock). */
const ageOrder = (id, madeDaysAgo, changed, status = null) =>
  query(
    `UPDATE crm_orders SET created_at = now() - make_interval(days => $2), updated_at = ($3::timestamp AT TIME ZONE $4), status = COALESCE($5, status) WHERE id = $1`,
    [id, madeDaysAgo, changed, TZ, status]
  );

/** Opens an event stream like a browser does and collects what arrives. */
async function openStream(path, cookie) {
  const ctl = new AbortController();
  const res = await fetch(base + path, { headers: { "CF-Connecting-IP": "198.51.100.29", Cookie: cookie }, signal: ctl.signal });
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
          if (data !== undefined) events.push({ event: /^event: (.*)$/m.exec(block)?.[1] || "message", data: JSON.parse(data), raw: data });
        }
      }
    } catch {
      // aborted
    }
  })();
  return {
    events,
    async next(match, ms = 3000) {
      const end = Date.now() + ms;
      for (;;) {
        const hit = events.find(match);
        if (hit || Date.now() > end) return hit || null;
        await wait(30);
      }
    },
    close: () => ctl.abort(),
  };
}

test("without recent=1 the snapshot answers as it always did", async () => {
  const o = await business();
  const plain = await o.snap();
  for (const key of ["windows", "counts", "gone"]) assert.equal(key in plain, false, `${key} only when asked`);
  assert.deepEqual(Object.keys(plain), ["rev", "id", "name", "role", "packages", "me", "modules", "settings", "sources", "tags", "fields", "apptStages", "orderStages",
    "deliveryMethods", "paymentMethods", "units", "serviceCategories", "productCategories", "customers", "staff", "services", "timeOff", "appointments", "series",
    "products", "movements", "orders", "notices", "branches"]);
  assert.deepEqual(Object.keys(await o.snap("?only=orders")), ["rev", "orders"]);
  const recent = await o.snap("?recent=1");
  assert.deepEqual(Object.keys(recent), [...Object.keys(plain), "counts", "windows"]);
  // Nothing old yet: the window holds everything, row for row.
  for (const key of ["customers", "appointments", "orders", "movements", "products", "staff"]) assert.deepEqual(recent[key], plain[key], key);
  assert.deepEqual(Object.keys(await o.snap("?only=counts")), ["rev", "counts"]);
  // Unknown query parameters stay ignored, as before.
  assert.deepEqual(await o.snap("?whatever=1"), plain);
});

test("the window's edges: bookings from N days ago on, open orders of any age, finished ones changed in the last N days, the newest M movements", async () => {
  const o = await business();
  const from = D(-7);
  const made = [];
  for (const hm of ["10:00", "11:00", "12:00", "13:00", "14:00"]) made.push(ok(await o.book({ start: `${D(2)}T${hm}` }), 201).id);
  const [edge, before, ahead, oldPending, longAgo] = made;
  await placeBooking(edge, `${from}T00:00`); // exactly N days old: in
  await placeBooking(before, `${addDays(from, -1)}T23:00`); // the evening before: out
  await placeBooking(oldPending, `${D(-30)}T09:00`, "new"); // still waiting for confirmation, long ago: in (the sidebar counts it)
  await placeBooking(longAgo, `${D(-60)}T09:00`, "done");

  const orders = [];
  for (let i = 0; i < 6; i++) orders.push(ok(await o.order({}), 201).id);
  const [openOld, heldOld, doneEdge, doneBefore, cancelledOld, cancelledNow] = orders;
  await ageOrder(openOld, 90, `${D(-90)}T10:00`); // open, months old: in
  await ageOrder(heldOld, 60, `${D(-60)}T10:00`, "confirmed"); // reserved, old: in
  await ageOrder(doneEdge, 40, `${from}T00:00`, "delivered"); // finished exactly N days ago: in
  await ageOrder(doneBefore, 40, `${addDays(from, -1)}T23:59`, "delivered"); // a minute earlier: out
  await ageOrder(cancelledOld, 40, `${D(-20)}T10:00`, "cancelled"); // cancelled long ago: out
  await ageOrder(cancelledNow, 40, `${today()}T00:01`, "cancelled"); // cancelled today: in

  const w = await o.snap("?recent=1&days=7&moves=2");
  assert.deepEqual(sorted(ids(w.appointments)), sorted([edge, ahead, oldPending]));
  assert.equal(w.counts.appointments.pending, 1, "what the sidebar counts, the window lists");
  assert.deepEqual(sorted(ids(w.orders)), sorted([openOld, heldOld, doneEdge, cancelledNow]));
  const all = await o.snap();
  assert.equal(all.movements.length, 2, "opening stock and a receipt");
  assert.deepEqual(w.movements, all.movements.slice(0, 2));
  assert.deepEqual(w.windows, { appointments: { from }, orders: { from }, movements: { limit: 2, next: null } });
  const one = await o.snap("?recent=1&moves=1&only=movements");
  assert.deepEqual(one.windows.movements, { limit: 1, next: all.movements[0].id });
  // Rows in the window are the snapshot's rows.
  for (const key of ["appointments", "orders"]) for (const row of w[key]) assert.deepEqual(row, all[key].find((r) => r.id === row.id), key);

  // Older rows on demand, in the same shape, a page at a time.
  const older = ok(await o.call("GET", `/appointments?from=${D(-90)}&to=${addDays(from, -1)}`));
  assert.deepEqual(ids(older.appointments), [longAgo, oldPending, before], "in the calendar's order");
  assert.deepEqual(older.appointments, [longAgo, oldPending, before].map((id) => all.appointments.find((a) => a.id === id)));
  const p1 = ok(await o.call("GET", `/appointments?from=${D(-90)}&to=${addDays(from, -1)}&limit=2`));
  assert.deepEqual([ids(p1.appointments), p1.next], [[longAgo, oldPending], oldPending]);
  const p2 = ok(await o.call("GET", `/appointments?from=${D(-90)}&to=${addDays(from, -1)}&limit=2&after=${p1.next}`));
  assert.deepEqual([ids(p2.appointments), p2.next], [[before], null]);
  assert.deepEqual(ids(ok(await o.call("GET", `/appointments?customerId=${o.c1}&staffId=${o.pa}`)).appointments).length, 5);

  const byNewest = ids(all.orders);
  const page1 = ok(await o.call("GET", "/orders?limit=4"));
  assert.deepEqual([ids(page1.orders), page1.next], [byNewest.slice(0, 4), byNewest[3]]);
  const page2 = ok(await o.call("GET", `/orders?limit=4&before=${page1.next}`));
  assert.deepEqual([ids(page2.orders), page2.next], [byNewest.slice(4), null]);
  assert.deepEqual(page1.orders, all.orders.slice(0, 4), "the snapshot's shape");
  const made40 = ok(await o.call("GET", `/orders?from=${D(-41)}&to=${D(-39)}`)).orders;
  assert.deepEqual(sorted(ids(made40)), sorted([doneEdge, doneBefore, cancelledOld, cancelledNow]));
  assert.equal(ok(await o.call("GET", `/orders?customerId=${o.c1}`)).orders.length, 6);
  const moves = ok(await o.call("GET", `/movements?productId=${o.product.id}&limit=1`));
  assert.deepEqual([moves.movements, moves.next], [all.movements.slice(0, 1), all.movements[0].id]);
  assert.deepEqual(ok(await o.call("GET", `/movements?before=${moves.next}`)).movements, all.movements.slice(1));

  refused(await o.call("GET", "/snapshot?recent=2"), 400, "bad_window");
  assert.equal(refused(await o.call("GET", "/snapshot?recent=1&days=0"), 400, "bad_window").param, "days");
  assert.equal(refused(await o.call("GET", "/snapshot?recent=1&moves=5000"), 400, "bad_window").param, "moves");
  refused(await o.call("GET", "/snapshot?recent=1&customers=some"), 400, "bad_window");
  assert.equal((await o.call("GET", `/appointments?from=${D(1)}`)).status, 400, "a span needs both ends");
  assert.equal((await o.call("GET", `/appointments?from=${D(1)}&to=${D(0)}`)).status, 400);
  assert.equal((await o.call("GET", `/appointments?from=${D(-400)}&to=${D(0)}`)).status, 400, "a year at most");
  assert.equal((await o.call("GET", "/orders?limit=501")).status, 400);
  assert.equal((await o.call("GET", "/movements?productId=nope")).status, 400);
});

test("counts for the sidebar and Today come from the database, whatever the window holds", async () => {
  const o = await business();
  const waiting = ok(await o.book({ start: `${D(2)}T10:00` }), 201).id;
  const old = ok(await o.book({ start: `${D(2)}T11:00` }), 201).id;
  const todays = ok(await o.book({ start: `${D(2)}T12:00` }), 201).id;
  await placeBooking(waiting, `${D(3)}T10:00`, "new");
  await placeBooking(old, `${D(-60)}T10:00`, "new");
  await placeBooking(todays, `${today()}T00:00`, "done");
  await query("UPDATE crm_appointments SET price = 70000 WHERE id = $1", [todays]);
  const open = ok(await o.order({}), 201).id;
  const held = ok(await o.order({}), 201).id;
  const sold = ok(await o.order({ delivery: { type: "pickup", date: today() }, force: true }), 201).id;
  ok(await o.call("POST", `/orders/${held}/step`, { to: "confirmed" }));
  ok(await o.call("POST", `/orders/${sold}/step`, { to: "delivered" }));
  void open;
  const { counts, windows } = await o.snap("?recent=1&days=7");
  assert.equal(windows.appointments.from, D(-7));
  assert.deepEqual(counts, {
    day: today(),
    customers: { total: 1, newMonth: 1 },
    appointments: { pending: 2, toConfirm: 1, today: 1, todayDone: 1, todayEarned: 70000, todayExpected: 70000 },
    orders: { open: 1, reserved: 1, toDeliver: 1, soldToday: 100000 },
  });
});

test("rows by id: one changed row instead of the whole key; deleted rows and others' rows are gone", async () => {
  const o = await business();
  const other = await business();
  const a = ok(await o.order({}), 201).id;
  const b = ok(await o.order({}), 201).id;
  const theirs = ok(await other.order({}), 201).id;
  const appt = ok(await o.book({}), 201).id;
  const all = await o.snap();
  const got = await o.snap(`?only=orders&ids=${a},${theirs}`);
  assert.deepEqual(got, { rev: all.rev, orders: [all.orders.find((x) => x.id === a)], gone: { orders: [theirs] } });
  ok(await o.call("DELETE", `/orders/${b}`));
  assert.deepEqual((await o.snap(`?only=orders&ids=${b}`)).gone, { orders: [b] }, "a deleted order is gone");
  assert.deepEqual((await o.snap(`?only=appointments&ids=${appt}`)).appointments, all.appointments);
  assert.deepEqual((await o.snap(`?only=customers&ids=${o.c1},${other.c1}`)), { rev: all.rev + 1, customers: all.customers, gone: { customers: [other.c1] } });
  assert.deepEqual((await o.snap(`?only=products&ids=${o.product.id}`)).products, all.products);
  assert.deepEqual((await o.snap(`?only=staff&ids=${o.pb}`)).staff, all.staff.filter((s) => s.id === o.pb), "a small key is kept to the ids too");
  assert.deepEqual((await o.snap(`?only=movements&ids=${all.movements[0].id}`)).movements, [all.movements[0]]);

  refused(await o.call("GET", `/snapshot?ids=${a}`), 400, "bad_ids");
  refused(await o.call("GET", `/snapshot?only=orders,products&ids=${a}`), 400, "bad_ids");
  refused(await o.call("GET", `/snapshot?only=settings&ids=${a}`), 400, "bad_ids");
  refused(await o.call("GET", `/snapshot?only=orders&recent=1&ids=${a}`), 400, "bad_ids");
  refused(await o.call("GET", "/snapshot?only=orders&ids=nope"), 400, "bad_ids");
  const many = Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`).join(",");
  assert.equal(refused(await o.call("GET", `/snapshot?only=orders&ids=${many}`), 400, "too_many_ids").max, 200);
});

test("live updates name the rows: one moved order is a small event, a deleted row is announced as deleted, too many say many", async () => {
  const o = await business();
  const other = await business();
  const order = ok(await o.order({}), 201).id;
  const gone = ok(await o.order({}), 201).id;
  await o.snap();
  const rich = await openStream(`${o.crm}/stream?rows=1`, o.b.cookie);
  const plain = await openStream(`${o.crm}/stream`, o.b.cookie);
  const far = await openStream(`${other.crm}/stream?rows=1`, other.b.cookie);
  try {
    for (const s of [rich, plain, far]) assert.ok(await s.next((e) => e.event === "ready"));
    const moved = ok(await o.call("POST", `/orders/${order}/step`, { to: "confirmed" }));
    const heard = await rich.next((e) => e.event === "crm" && e.data.k.includes("orders"));
    assert.deepEqual(heard.data.ids.orders, [order], "the order that moved, by id");
    assert.deepEqual(heard.data.ids.products, [o.product.id], "its goods are held: the product's numbers changed");
    assert.deepEqual(heard.data.revs, [moved.rev], "the write's rev: the screen that made it already has it");
    assert.ok(heard.raw.length < 400, `${heard.raw.length} bytes`);
    assert.equal(/lines|history|totals/.test(heard.raw), false, "never the rows themselves");
    const old = await plain.next((e) => e.event === "crm");
    assert.deepEqual(Object.keys(old.data), ["k"], "a stream opened without rows=1 hears what it always heard");
    assert.deepEqual(sorted(old.data.k), sorted(heard.data.k));

    rich.events.length = 0;
    ok(await o.call("DELETE", `/orders/${gone}`));
    const deleted = await rich.next((e) => e.event === "crm" && e.data.k.includes("orders"));
    assert.deepEqual([deleted.data.del.orders, deleted.data.ids.orders], [[gone], undefined]);

    // A removed step moves every order in it at once: one statement over 150 orders is "many".
    const customer = o.c1;
    await query(
      `INSERT INTO crm_orders (workspace_id, branch_id, number, customer_id, status)
       SELECT $1, $2, 50000 + g, $3, 'packing' FROM generate_series(1, 150) g`,
      [o.ws.id, o.A, customer]
    );
    const bulk = await rich.next((e) => e.event === "crm" && e.data.ids?.orders === "many");
    assert.ok(bulk, "150 new rows at once");
    assert.equal("revs" in bulk.data, false, "made outside a write: no rev to skip by");
    await wait(300);
    rich.events.length = 0;
    const stages = (await o.snap("?only=orderStages")).orderStages.filter((s) => s.id !== "packing");
    ok(await o.call("PUT", "/settings", { orderStages: stages, moves: { orderStages: [{ from: "packing", to: "confirmed" }] } }));
    const many = await rich.next((e) => e.event === "crm" && e.data.k.includes("orders"));
    assert.equal(many.data.ids.orders, "many");
    assert.ok(many.data.k.includes("settings"));
    assert.equal("settings" in many.data.ids, false, "the lists name no rows: refetch only=settings");
    await wait(300);
    assert.equal(far.events.some((e) => e.event === "crm"), false, "another workspace hears nothing");
  } finally {
    rich.close();
    plain.close();
    far.close();
  }
});

test("another workspace's ids and cursors answer nothing on every new route", async () => {
  const o = await business();
  const x = await business();
  const theirs = { order: ok(await x.order({}), 201).id, appt: ok(await x.book({}), 201).id, move: (await x.snap("?only=movements")).movements[0].id };
  ok(await o.order({}), 201);
  ok(await o.book({}), 201);
  const empty = async (path, key) => assert.deepEqual(ok(await o.call("GET", path)), { [key]: [], next: null }, path);
  await empty(`/appointments?customerId=${x.c1}`, "appointments");
  await empty(`/appointments?from=${D(0)}&to=${D(5)}&staffId=${x.pa}`, "appointments");
  await empty(`/appointments?from=${D(0)}&to=${D(5)}&after=${theirs.appt}`, "appointments");
  await empty(`/orders?customerId=${x.c1}`, "orders");
  await empty(`/orders?before=${theirs.order}`, "orders");
  await empty(`/movements?productId=${x.product.id}`, "movements");
  await empty(`/movements?before=${theirs.move}`, "movements");
  await empty(`/customers?after=${x.c1}`, "customers");
  assert.deepEqual(ok(await o.call("GET", "/customers?q=Karimov")).customers.map((c) => c.id), [o.c1], "their Jasur Karimov is theirs");
  for (const [key, id] of [["orders", theirs.order], ["appointments", theirs.appt], ["movements", theirs.move], ["customers", x.c1], ["products", x.product.id], ["staff", x.pa], ["branches", x.B]]) {
    const got = await o.snap(`?only=${key}&ids=${id}`);
    assert.deepEqual([got[key], got.gone[key]], [[], [id]], key);
  }
  // Their routes stay theirs.
  assert.equal((await o.b.call("GET", `${x.crm}/orders`)).status, 404);
  assert.equal((await o.b.call("GET", `${x.crm}/snapshot?only=orders&ids=${theirs.order}`)).status, 404);
});

test("a team member limited to a branch, or to their own bookings, never gets others' rows through ids, ranges or counts", async () => {
  const o = await business();
  const orderA = ok(await o.order({}), 201).id;
  const orderB = ok(await o.order({ branchId: o.B, lines: [{ productId: o.product.id, qty: 1 }] }), 201).id;
  const apptA = ok(await o.book({ staffId: o.pa }), 201).id;
  const apptB = ok(await o.book({ staffId: o.pb }), 201).id;
  const all = await o.snap();
  const moveA = all.movements.find((m) => m.branchId === o.A).id;

  const mate = await teammate(o, "agent", "Sherzod Karimov");
  ok(await o.call("PUT", `/branches/members/${mate.user.id}`, { branchId: o.B }));
  const as = (path) => mate.b.call("GET", o.crm + path);
  const gone = async (key, id) => assert.deepEqual(ok(await as(`/snapshot?only=${key}&ids=${id}`)).gone[key], [id], `${key} of the other branch`);
  await gone("orders", orderA);
  await gone("appointments", apptA);
  await gone("movements", moveA);
  assert.deepEqual(ids(ok(await as(`/snapshot?only=orders&ids=${orderB}`)).orders), [orderB]);
  assert.deepEqual(ids(ok(await as("/orders")).orders), [orderB]);
  assert.deepEqual(ids(ok(await as(`/orders?customerId=${o.c1}`)).orders), [orderB]);
  assert.deepEqual([...new Set(ok(await as("/movements")).movements.map((m) => m.branchId))], [o.B]);
  assert.deepEqual(ids(ok(await as(`/movements?productId=${o.product.id}`)).movements).includes(moveA), false);
  assert.deepEqual(ids(ok(await as(`/appointments?from=${D(0)}&to=${D(5)}`)).appointments), [apptB]);
  const limited = ok(await as("/snapshot?recent=1"));
  assert.deepEqual([ids(limited.orders), ids(limited.appointments)], [[orderB], [apptB]]);
  assert.deepEqual([limited.counts.orders.open, limited.counts.appointments.pending + limited.counts.appointments.toConfirm], [1, 0]);

  const own = await teammate(o, "agent", "Dilnoza Rahimova");
  ok(await o.call("PUT", `/staff/${o.pa}`, { userId: own.user.id, ownOnly: true }));
  const mine = (path) => own.b.call("GET", o.crm + path);
  assert.deepEqual(ok(await mine(`/snapshot?only=appointments&ids=${apptA},${apptB}`)).gone.appointments, [apptB]);
  assert.deepEqual(ids(ok(await mine(`/appointments?from=${D(0)}&to=${D(5)}`)).appointments), [apptA]);
  assert.deepEqual(ids(ok(await mine(`/appointments?customerId=${o.c1}`)).appointments), [apptA]);
  assert.equal((await mine(`/appointments?from=${D(0)}&to=${D(5)}&staffId=${o.pb}`)).status, 403, "another specialist's calendar");
  await placeBooking(apptB, `${D(3)}T10:00`, "new");
  assert.equal(ok(await mine("/snapshot?only=counts")).counts.appointments.pending, 0, "the other specialist's waiting booking isn't theirs to count");
  assert.equal(ok(await o.call("GET", "/snapshot?only=counts")).counts.appointments.pending, 1);
});

test("an owner looking at one branch pages that branch's older rows, as the snapshot narrows to it", async () => {
  const o = await business();
  const orderA = ok(await o.order({}), 201).id;
  const orderB = ok(await o.order({ branchId: o.B }), 201).id;
  const apptA = ok(await o.book({ staffId: o.pa }), 201).id;
  const apptB = ok(await o.book({ staffId: o.pb }), 201).id;
  const span = `from=${D(0)}&to=${D(5)}`;
  const snapB = await o.snap(`?only=orders,movements,appointments&branch=${o.B}`);
  assert.deepEqual([ids(snapB.orders), ids(snapB.appointments)], [[orderB], [apptB]]);
  assert.deepEqual(ids(ok(await o.call("GET", `/orders?branch=${o.B}`)).orders), [orderB]);
  assert.deepEqual(ids(ok(await o.call("GET", `/orders?branch=${o.A}&customerId=${o.c1}`)).orders), [orderA]);
  assert.deepEqual(ok(await o.call("GET", `/movements?branch=${o.B}`)).movements, snapB.movements);
  assert.deepEqual(ids(ok(await o.call("GET", `/movements?branch=${o.B}&productId=${o.product.id}`)).movements), ids(snapB.movements));
  assert.deepEqual(ids(ok(await o.call("GET", `/appointments?${span}&branch=${o.B}`)).appointments), [apptB]);
  assert.deepEqual(ids(ok(await o.call("GET", `/appointments?${span}&branch=${o.A}`)).appointments), [apptA]);
  assert.deepEqual(sorted(ids(ok(await o.call("GET", "/orders")).orders)), sorted([orderA, orderB]), "without it, every branch");
  // The same refusals as the snapshot's: a branch that isn't theirs, one limited person asking for another.
  const x = await business();
  for (const path of [`/orders?branch=${x.B}`, `/movements?branch=${x.B}`, `/appointments?${span}&branch=${x.B}`, "/orders?branch=nope"]) {
    refused(await o.call("GET", path), 400, "bad_branch");
  }
  const mate = await teammate(o, "agent", "Sherzod Karimov");
  ok(await o.call("PUT", `/branches/members/${mate.user.id}`, { branchId: o.B }));
  for (const path of [`/orders?branch=${o.A}`, `/movements?branch=${o.A}`, `/appointments?${span}&branch=${o.A}`]) {
    refused(await mate.b.call("GET", o.crm + path), 403, "other_branch");
  }
  assert.deepEqual(ids(ok(await mate.b.call("GET", `${o.crm}/orders?branch=${o.B}`)).orders), [orderB]);
});

test("every CRM SQL file, run again on its own, leaves the live-update triggers that name rows (one definition)", async () => {
  const dir = new URL("../sql/crm/", import.meta.url);
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await query(fs.readFileSync(new URL(file, dir), "utf-8"));
  // 00-core alone, as a test or a fix-up might run it, after all the others.
  await query(fs.readFileSync(new URL("00-core.sql", dir), "utf-8"));
  const { rows } = await query(
    `SELECT tgrelid::regclass::text AS tbl, array_agg(tgname::text ORDER BY tgname) AS names FROM pg_trigger
      WHERE tgname = 'crm_notify' OR tgname LIKE 'crm_announce_%' GROUP BY 1 ORDER BY 1`
  );
  const announce = ["crm_announce_delete", "crm_announce_insert", "crm_announce_update"];
  const tables = ["crm_appointments", "crm_branches", "crm_customers", "crm_member_branches", "crm_notices", "crm_order_lines", "crm_orders", "crm_payments",
    "crm_products", "crm_series", "crm_services", "crm_staff", "crm_stock", "crm_stock_moves", "crm_time_off", "crm_variants"];
  assert.deepEqual(rows, [...tables.map((tbl) => ({ tbl, names: announce })), { tbl: "crm_settings", names: ["crm_notify"] }].sort((a, b) => a.tbl.localeCompare(b.tbl)));
  // A customer write after that is one announcement that names the row and the write.
  const o = await business();
  const stream = await openStream(`${o.crm}/stream?rows=1`, o.b.cookie);
  try {
    assert.ok(await stream.next((e) => e.event === "ready"));
    const made = ok(await o.call("POST", "/customers", { name: "Nodira" }), 201);
    const hit = await stream.next((e) => e.event === "crm" && e.data.k.includes("customers"));
    assert.deepEqual([hit.data.ids, hit.data.revs], [{ customers: [made.id] }, [made.rev]], "named, and known as this write's");
  } finally {
    stream.close();
  }
});

test("customers: the window can carry only the ones its rows are about, and the rest are found by search, a page at a time", async () => {
  const o = await business();
  const post = async (body) => ok(await o.call("POST", "/customers", body), 201).id;
  const linked = await post({ name: "Malika Aliyeva", phone: "+998935550011" });
  const quiet = await post({ name: "Old Friend", telegram: "old_friend_42" });
  const fresh = await post({ name: "New Face 100%" });
  await query("UPDATE crm_customers SET created_at = now() - make_interval(days => 60 - array_position($1::uuid[], id)) WHERE id = ANY($1::uuid[])", [[o.c1, linked, quiet]]);
  ok(await o.book({ customerId: linked }), 201);
  const w = await o.snap("?recent=1&days=7&customers=linked");
  assert.deepEqual(sorted(ids(w.customers)), sorted([linked, fresh]), "the booking's customer and the one added this week");
  assert.deepEqual(w.windows.customers, { from: D(-7), linked: true });
  assert.deepEqual((await o.snap("?recent=1&days=7&customers=linked&only=customers")).customers, w.customers, "asked alone, the same customers");
  assert.equal((await o.snap("?recent=1")).customers.length, 4, "customers=all (the default) keeps the whole list");
  assert.equal(w.counts.customers.total, 4);

  const find = async (q) => ids(ok(await o.call("GET", `/customers?q=${encodeURIComponent(q)}`)).customers);
  assert.deepEqual(await find("KARIM"), [o.c1], "any letter case, any part of the name");
  assert.deepEqual(await find("5550011"), [linked], "phone digits");
  assert.deepEqual(await find("friend_4"), [quiet], "the Telegram handle");
  assert.deepEqual(await find("100%"), [fresh], "% is a letter, not a wildcard");
  assert.deepEqual(await find("%"), [fresh]);
  assert.deepEqual(await find("zzz"), []);
  const page = ok(await o.call("GET", "/customers?limit=3"));
  assert.deepEqual([ids(page.customers), page.next], [[o.c1, linked, quiet], quiet]);
  assert.deepEqual(ok(await o.call("GET", `/customers?after=${page.next}`)), { customers: (await o.snap()).customers.slice(3), next: null });
  assert.equal((await o.call("GET", "/customers?limit=0")).status, 400);
});
