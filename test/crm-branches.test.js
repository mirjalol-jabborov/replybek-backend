// Branches: a business with more than one place. The pure rules (shared/branches.js and the branch
// parts of shared/booking.js) first, then through the API: setting branches up, specialists and
// their bookings, the booking rules a branch sets, stock per branch, orders filled from one branch,
// moving goods between branches (also under a race), a team member limited to one branch, and
// another workspace's branch refused everywhere. After every stock change the cached numbers must
// be the ledger added up, per variant and branch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { crmOwner, teammate, query } from "./helpers/setup.js";
import { nowIn, addDays, dayOf, weekday } from "../src/crm/shared/time.js";
import { planTransfer, withinBranch, offFor, poolOf, placeOf } from "../src/crm/shared/branches.js";
import { check, freeStarts, whyNone, bookingsInside } from "../src/crm/shared/booking.js";

const today = () => dayOf(nowIn("Asia/Tashkent", new Date()));
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
const codes = (list) => (list || []).map((r) => r.code);

/* ───── Pure rules ───── */

test("pure: a branch's own hours cut a specialist's, closed days count for their own branch only", () => {
  const day = "2026-11-18"; // a Wednesday
  const wd = weekday(day);
  const open = { id: "A", hours: { ...ALL_DAY, [wd]: ["10:00", "14:00"] } };
  assert.deepEqual(withinBranch([540, 1080], open, day), [600, 840]);
  assert.equal(withinBranch([540, 1080], { id: "A", hours: { ...ALL_DAY, [wd]: null } }, day), null);
  assert.equal(withinBranch([900, 1080], open, day), null, "nothing of the span is left");
  assert.deepEqual(withinBranch([540, 1080], { id: "A", hours: null }, day), [540, 1080], "no own hours: the person's");
  assert.equal(offFor({ staffId: "p1" }, "p1", "A"), true);
  assert.equal(offFor({ staffId: "p1" }, "p2", "A"), false);
  assert.equal(offFor({ staffId: null, branchId: "A" }, "p1", "A"), true);
  assert.equal(offFor({ staffId: null, branchId: "B" }, "p1", "A"), false);
  assert.equal(offFor({ staffId: null }, "p1", "A"), true, "a closed day without a branch is everywhere");
  assert.equal(offFor({ staffId: null, branchId: "B" }, "p1", undefined), true, "a person without a branch: everywhere");
  const db = { staff: [{ id: "p1", branchId: "A" }, { id: "p2", branchId: "B" }], branches: [open] };
  assert.deepEqual(poolOf(db, "B").staff.map((p) => p.id), ["p2"]);
  assert.equal(poolOf(db, null), db);
  assert.equal(placeOf(db, db.staff[0]), open);
  assert.equal(placeOf(db, { id: "x" }), null);
});

test("pure: check() reads the branch: its hours, its closed days, a closed branch", () => {
  const day = D(2);
  const wd = weekday(day);
  const base = {
    settings: { rules: { minNotice: 0, maxDays: 60, step: 15, override: true } },
    apptStages: [{ id: "ok", kind: "booked" }],
    services: [{ id: "s", duration: 30, price: 1, active: true }],
    staff: [{ id: "a", active: true, serviceIds: ["s"], hours: ALL_DAY, branchId: "A" }, { id: "b", active: true, serviceIds: ["s"], hours: ALL_DAY, branchId: "B" }],
    appointments: [],
    timeOff: [{ id: "t", staffId: null, start: `${day}T00:00`, end: `${day}T23:59`, note: "", branchId: "B" }],
    branches: [{ id: "A", hours: { ...ALL_DAY, [wd]: ["10:00", "14:00"] }, active: true }, { id: "B", hours: null, active: true }],
  };
  const at = (staffId, hm) => check(base, { staffId, serviceIds: ["s"], start: `${day}T${hm}`, duration: 30 }, { now: `${today()}T00:00` });
  assert.deepEqual(at("a", "11:00"), { hard: [], soft: [] });
  assert.deepEqual(at("a", "15:00").soft, [{ code: "outside_hours", staffId: "a", from: "10:00", to: "14:00" }]);
  assert.deepEqual(codes(at("b", "11:00").soft), ["closed"], "B is closed that day");
  // "Anyone": A's specialist is free, B is closed; the whole day reads closed only when both are.
  assert.deepEqual(freeStarts(base, { staffId: null, serviceIds: ["s"], day, duration: 30 }, { now: `${today()}T00:00` }).map((s) => s.staffId)[0], "a");
  assert.equal(whyNone(poolOf(base, "B"), { staffId: null, serviceIds: ["s"], day }, { now: `${today()}T00:00` }).code, "closed");
  assert.equal(whyNone(base, { staffId: null, serviceIds: ["s"], day }, { now: `${today()}T00:00` }).code, "full");
  const shut = { ...base, branches: [{ id: "A", hours: null, active: false }, base.branches[1]] };
  assert.deepEqual(codes(check(shut, { staffId: "a", serviceIds: ["s"], start: `${day}T11:00`, duration: 30 }, { now: `${today()}T00:00` }).hard), ["branch_closed"]);
  // A closed day of B has inside it only B's bookings.
  const booked = { ...base, appointments: [{ id: "x", staffId: "a", start: `${day}T11:00`, duration: 30, status: "ok", branchId: "A" }, { id: "y", staffId: "b", start: `${day}T11:00`, duration: 30, status: "ok", branchId: "B" }] };
  assert.deepEqual(bookingsInside(booked, base.timeOff[0]).map((a) => a.id), ["y"]);
});

test("pure: moving goods takes only what is free at the sending branch, as a pair of lines", () => {
  const stock = { v1: { variantId: "v1", productId: "p", name: "Roses", stock: 10, reserved: 3 } };
  assert.deepEqual(planTransfer(stock, [{ variantId: "v1", qty: 4 }, { variantId: "v1", qty: 3 }]).movements, [
    { variantId: "v1", type: "transfer", qty: -7, side: "from" },
    { variantId: "v1", type: "transfer", qty: 7, side: "to" },
  ]);
  assert.deepEqual(planTransfer(stock, [{ variantId: "v1", qty: 8 }]), {
    ok: false, missing: [{ code: "transfer_short", variantId: "v1", productId: "p", name: "Roses", need: 8, free: 7, reserved: 3 }],
  });
});

/* ───── Through the API ───── */

/** A CRM workspace with a second branch, a service, a specialist at each branch and a customer. */
async function business() {
  const o = await crmOwner();
  const call = (method, path, body, b = o.b) => b.call(method, o.crm + path, body);
  const snap = async (query = "", b = o.b) => ok(await b.call("GET", `${o.crm}/snapshot${query}`));
  const A = (await snap("?only=branches")).branches[0].id;
  const B = ok(await call("POST", "/branches", { name: "Chilonzor", address: "Bunyodkor 1", phone: "+998 71 200 00 00" }), 201).id;
  const s1 = ok(await call("POST", "/services", { name: "Haircut", duration: 30, price: 50000 }), 201).id;
  const pa = ok(await call("POST", "/staff", { name: "Aziz", hours: ALL_DAY, serviceIds: [s1] }), 201).id;
  const pb = ok(await call("POST", "/staff", { name: "Bek", hours: ALL_DAY, serviceIds: [s1], branchId: B }), 201).id;
  const c1 = ok(await call("POST", "/customers", { name: "Jasur Karimov" }), 201).id;
  const book = (body, b) => call("POST", "/appointments", { customerId: c1, serviceIds: [s1], start: `${D(2)}T10:00`, ...body }, b);
  const product = async (body = {}) => ok(await call("POST", "/products", { name: "Roses", sku: `R${Math.random().toString(36).slice(2, 9)}`, price: 100000, ...body }), 201).changes.set.products[0];
  const stages = (await snap("?only=orderStages")).orderStages;
  const held = stages.find((s) => s.kind === "reserved").id;
  const done = stages.find((s) => s.kind === "done").id;
  const order = (body, b) => call("POST", "/orders", { customerId: c1, delivery: { type: "pickup" }, ...body }, b);
  return { ...o, call, snap, A, B, s1, pa, pb, c1, book, product, held, done, order };
}

/** The cached numbers are the ledger added up, for every variant at every branch, and never out of bounds. */
async function ledgerHolds(o) {
  const { rows } = await query(
    `WITH k AS (SELECT variant_id, branch_id FROM crm_stock WHERE workspace_id = $1 UNION SELECT variant_id, branch_id FROM crm_stock_moves WHERE workspace_id = $1),
          m AS (SELECT variant_id, branch_id, sum(qty) FILTER (WHERE type NOT IN ('reserve', 'release')) AS on_hand, sum(qty) FILTER (WHERE type IN ('reserve', 'release')) AS held
                  FROM crm_stock_moves WHERE workspace_id = $1 GROUP BY 1, 2)
     SELECT k.variant_id, k.branch_id, COALESCE(s.on_hand, 0)::float8 AS on_hand, COALESCE(s.reserved, 0)::float8 AS reserved,
            COALESCE(m.on_hand, 0)::float8 AS ledger_on_hand, COALESCE(m.held, 0)::float8 AS ledger_reserved
       FROM k LEFT JOIN crm_stock s USING (variant_id, branch_id) LEFT JOIN m USING (variant_id, branch_id)`,
    [o.ws.id]
  );
  assert.ok(rows.length, "there is stock to check");
  for (const r of rows) {
    const at = `variant ${r.variant_id} at ${r.branch_id}`;
    assert.deepEqual([r.on_hand, r.reserved], [r.ledger_on_hand, r.ledger_reserved], `${at}: counters = ledger`);
    assert.ok(r.on_hand >= 0 && r.reserved >= 0 && r.reserved <= r.on_hand, `${at}: within bounds`);
  }
  // Moving goods never changes the business's totals: the transfer lines of each variant add up to nothing.
  const { rows: moved } = await query("SELECT variant_id, sum(qty)::float8 AS net, count(*)::int AS n FROM crm_stock_moves WHERE workspace_id = $1 AND type = 'transfer' GROUP BY 1", [o.ws.id]);
  for (const r of moved) assert.deepEqual([r.net, r.n % 2], [0, 0], `variant ${r.variant_id}: transfers come in pairs`);
  return rows;
}

test("one branch: the default one, and no branch numbers in the other rows", async () => {
  const o = await crmOwner();
  const db = ok(await o.b.call("GET", `${o.crm}/snapshot`));
  assert.deepEqual(db.branches, [{ id: db.branches[0].id, name: "", address: "", phone: "", hours: null, active: true, default: true, members: [] }]);
  const p = ok(await o.b.call("POST", `${o.crm}/products`, { name: "Roses", price: 1000, opening: 3 }), 201);
  assert.equal("branches" in p.changes.set.products[0], false);
  assert.equal("branches" in p.changes.set.products[0].variants[0], false);
  assert.equal("branchId" in p.changes.set.movements[0], false);
  // ?branch= the one branch reads the same rows.
  const all = ok(await o.b.call("GET", `${o.crm}/snapshot?only=products,movements`));
  const one = ok(await o.b.call("GET", `${o.crm}/snapshot?only=products,movements&branch=${db.branches[0].id}`));
  assert.deepEqual(one, all);
});

test("branches: add, edit, close, delete; the default stays; admins only", async () => {
  const o = await business();
  const db = await o.snap("?only=branches");
  assert.deepEqual(db.branches.map((b) => [b.id, b.name, b.default]), [[o.A, "", true], [o.B, "Chilonzor", false]], "the default first");
  assert.deepEqual(db.branches[1], { id: o.B, name: "Chilonzor", address: "Bunyodkor 1", phone: "+998712000000", hours: null, active: true, default: false, members: [] });
  refused(await o.call("POST", "/branches", { name: "" }), 400, "name_required");
  refused(await o.call("POST", "/branches", { name: "X", phone: "12" }), 400, "bad_phone");
  assert.equal((await o.call("POST", "/branches", { name: "X", hours: { 0: ["10:00", "09:00"] } })).status, 400);
  const hours = { ...ALL_DAY, 0: null };
  const edited = ok(await o.call("PUT", `/branches/${o.B}`, { hours, address: "Bunyodkor 2" })).changes.set.branches[0];
  assert.deepEqual([edited.hours, edited.address], [hours, "Bunyodkor 2"]);
  ok(await o.call("PUT", `/branches/${o.B}`, { hours: null }));
  // The default one: renamed yes, emptied name yes (it goes by the workspace's), closed or deleted no.
  assert.equal(ok(await o.call("PUT", `/branches/${o.A}`, { name: "Yunusobod" })).changes.set.branches[0].name, "Yunusobod");
  ok(await o.call("PUT", `/branches/${o.A}`, { name: "" }));
  refused(await o.call("PUT", `/branches/${o.B}`, { name: "" }), 400, "name_required");
  refused(await o.call("PUT", `/branches/${o.A}`, { active: false }), 409, "default_branch");
  refused(await o.call("DELETE", `/branches/${o.A}`), 409, "default_branch");
  // A branch with a specialist stays (close it instead); one nothing happened at goes.
  assert.deepEqual(refused(await o.call("DELETE", `/branches/${o.B}`), 409, "branch_in_use").uses, "staff");
  const empty = ok(await o.call("POST", "/branches", { name: "Sergeli" }), 201).id;
  assert.deepEqual(ok(await o.call("DELETE", `/branches/${empty}`)).changes, { del: { branches: [empty] } });
  assert.equal((await o.call("PUT", `/branches/${empty}`, { name: "Again" })).status, 404);
  // Team members can't set branches up.
  const mate = await teammate(o, "agent");
  assert.equal((await o.call("POST", "/branches", { name: "Mine" }, mate.b)).status, 403);
  assert.equal((await o.call("PUT", `/branches/${o.B}`, { name: "Mine" }, mate.b)).status, 403);
  assert.equal((await o.call("DELETE", `/branches/${o.B}`, undefined, mate.b)).status, 403);
});

test("specialists: one branch each; bookings and time off carry it; a move reports the bookings ahead and moves none", async () => {
  const o = await business();
  const staff = (await o.snap("?only=staff")).staff;
  assert.deepEqual(staff.map((p) => [p.id, p.branchId]), [[o.pa, o.A], [o.pb, o.B]]);
  const a = ok(await o.book({ staffId: o.pb }), 201).changes.set.appointments[0];
  assert.equal(a.branchId, o.B, "the booking is where its specialist works");
  const off = ok(await o.call("POST", "/time-off", { staffId: o.pb, start: `${D(3)}T00:00`, end: `${D(3)}T23:59`, branchId: o.A }), 201).changes.set.timeOff[0];
  assert.equal(off.branchId, o.B, "a specialist's time off is where they work, whatever was sent");
  // Given to another specialist, a booking goes to their branch.
  const moved = ok(await o.call("POST", `/appointments/${a.id}/move`, { staffId: o.pa })).changes.set.appointments[0];
  assert.equal(moved.branchId, o.A);
  ok(await o.call("POST", `/appointments/${a.id}/move`, { staffId: o.pb }));

  // Bek moves to A: his time off ahead goes with him, his booking stays at B and is reported.
  const r = ok(await o.call("PUT", `/staff/${o.pb}`, { branchId: o.A }));
  assert.equal(r.changes.set.staff[0].branchId, o.A);
  assert.deepEqual(r.changes.set.timeOff.map((t) => [t.id, t.branchId]), [[off.id, o.A]]);
  assert.deepEqual(r.ahead, { count: 1, ids: [a.id] });
  const still = (await o.snap("?only=appointments")).appointments.find((x) => x.id === a.id);
  assert.deepEqual([still.branchId, still.staffId, still.status], [o.B, o.pb, a.status], "never moved or cancelled");
  assert.equal(ok(await o.book({ staffId: o.pb, start: `${D(4)}T10:00` }), 201).changes.set.appointments[0].branchId, o.A, "new bookings: the new branch");
  // Back to B: now the booking made at A is the one reported.
  assert.equal(ok(await o.call("PUT", `/staff/${o.pb}`, { branchId: o.B })).ahead.count, 1);

  // A closed branch takes no new specialists; another workspace's branch is refused.
  ok(await o.call("PUT", `/branches/${o.B}`, { active: false }));
  refused(await o.call("POST", "/staff", { name: "New", hours: ALL_DAY, branchId: o.B }), 409, "branch_closed");
  refused(await o.call("PUT", `/staff/${o.pa}`, { branchId: o.B }), 409, "branch_closed");
});

test("booking rules: a branch's own hours and closed days, anyone at a branch, a closed branch", async () => {
  const o = await business();
  const day = D(2);
  const wd = weekday(day);
  const ask = (body) => o.call("POST", "/booking/check", { serviceIds: [o.s1], start: `${day}T15:00`, ...body }).then((r) => ok(r));
  assert.equal((await ask({ staffId: o.pb })).ok, true);
  ok(await o.call("PUT", `/branches/${o.B}`, { hours: { ...ALL_DAY, [wd]: ["10:00", "14:00"] } }));
  assert.deepEqual((await ask({ staffId: o.pb })).soft, [{ code: "outside_hours", staffId: o.pb, from: "10:00", to: "14:00" }]);
  assert.equal((await ask({ staffId: o.pa })).ok, true, "A keeps its specialists' hours");
  ok(await o.call("PUT", `/branches/${o.B}`, { hours: { ...ALL_DAY, [wd]: null } }));
  assert.deepEqual(codes((await ask({ staffId: o.pb })).soft), ["day_off"]);
  ok(await o.call("PUT", `/branches/${o.B}`, { hours: null }));

  // A closed day at A: A's bookings inside are reported, B's are not; B is still open.
  const inA = ok(await o.book({ staffId: o.pa }), 201).id;
  ok(await o.book({ staffId: o.pb }), 201);
  const shut = ok(await o.call("POST", "/time-off", { start: `${day}T00:00`, end: `${day}T23:59`, note: "Holiday" }), 201);
  assert.deepEqual([shut.changes.set.timeOff[0].branchId, shut.inside], [o.A, { count: 1, ids: [inA] }]);
  assert.deepEqual(codes((await ask({ staffId: o.pa, start: `${day}T12:00` })).soft), ["closed"]);
  assert.equal((await ask({ staffId: o.pb, start: `${day}T12:00` })).ok, true);

  // "Anyone" at a branch picks among its specialists; free times too.
  assert.equal((await ask({ staffId: null, branchId: o.B, start: `${day}T12:00` })).staffId, o.pb);
  const slots = ok(await o.call("GET", `/booking/slots?day=${day}&serviceIds=${o.s1}&branchId=${o.A}`));
  assert.deepEqual([slots.slots.length, slots.none?.code], [0, "closed"]);
  const atB = ok(await o.book({ staffId: null, branchId: o.B, start: `${day}T13:00` }), 201).changes.set.appointments[0];
  assert.deepEqual([atB.staffId, atB.branchId], [o.pb, o.B]);
  // A closed day can move to another branch; a specialist's time off can't.
  assert.equal(ok(await o.call("PUT", `/time-off/${shut.id}`, { branchId: o.B })).changes.set.timeOff[0].branchId, o.B);

  // A closed branch: no new bookings there, named or "anyone".
  ok(await o.call("PUT", `/branches/${o.B}`, { active: false }));
  assert.deepEqual(codes((await ask({ staffId: o.pb, start: `${D(3)}T12:00` })).hard), ["branch_closed"]);
  refused(await o.book({ staffId: null, branchId: o.B, start: `${D(3)}T12:00` }), 409, "branch_closed");
  assert.equal(ok(await o.book({ staffId: null, start: `${D(3)}T12:00` }), 201).changes.set.appointments[0].staffId, o.pa, "anyone anywhere skips it");
});

test("stock per branch: receive, write off and count name a branch; the snapshot adds up and breaks down; ?branch= narrows", async () => {
  const o = await business();
  const p = await o.product({ opening: 10 });
  const v = p.variants[0].id;
  assert.deepEqual(p.branches, { [o.A]: { stock: 10, reserved: 0 } }, "two branches: the breakdown comes");
  const got = ok(await o.call("POST", "/stock/receive", { lines: [{ productId: p.id, qty: 4 }], branchId: o.B, note: "Morning" }));
  assert.deepEqual([got.changes.set.products[0].stock, got.changes.set.products[0].branches], [14, { [o.A]: { stock: 10, reserved: 0 }, [o.B]: { stock: 4, reserved: 0 } }]);
  assert.deepEqual(got.changes.set.products[0].variants[0].branches, { [o.A]: { stock: 10, reserved: 0 }, [o.B]: { stock: 4, reserved: 0 } });
  assert.deepEqual(got.changes.set.movements.map((m) => [m.type, m.qty, m.branchId]), [["receipt", 4, o.B]]);
  await ledgerHolds(o);
  const off = ok(await o.call("POST", "/stock/write-off", { variantId: v, qty: 1, reason: "damaged", branchId: o.B }));
  assert.deepEqual(off.changes.set.products[0].branches[o.B], { stock: 3, reserved: 0 });
  refused(await o.call("POST", "/stock/write-off", { variantId: v, qty: 4, reason: "damaged", branchId: o.B }), 422, "rules");
  await ledgerHolds(o);
  const counted = ok(await o.call("POST", "/stock/count", { variantId: v, counted: 5, branchId: o.B }));
  assert.deepEqual([counted.diff, counted.changes.set.products[0].stock], [2, 15]);
  await ledgerHolds(o);
  // Left out, the branch is the default one.
  ok(await o.call("POST", "/stock/receive", { lines: [{ variantId: v, qty: 1 }] }));
  assert.deepEqual((await o.snap("?only=products")).products[0].branches, { [o.A]: { stock: 11, reserved: 0 }, [o.B]: { stock: 5, reserved: 0 } });
  // Narrowed to B: B's numbers, no breakdown, only B's lines and orders.
  ok(await o.order({ lines: [{ variantId: v, qty: 1 }], branchId: o.B }), 201);
  ok(await o.order({ lines: [{ variantId: v, qty: 1 }] }), 201);
  const atB = await o.snap(`?only=products,movements,orders&branch=${o.B}`);
  assert.deepEqual([atB.products[0].stock, "branches" in atB.products[0], "branches" in atB.products[0].variants[0]], [5, false, false]);
  assert.deepEqual([...new Set(atB.movements.map((m) => m.branchId))], [o.B]);
  assert.deepEqual([atB.orders.length, atB.orders[0].branchId], [1, o.B]);
  refused(await o.b.call("GET", `${o.crm}/snapshot?branch=nope`), 400, "bad_branch");
  // A variant with stock at any branch can't be taken off its product.
  const plain = await o.product();
  ok(await o.call("POST", "/stock/receive", { lines: [{ productId: plain.id, qty: 2 }], branchId: o.B }));
  refused(await o.call("PUT", `/products/${plain.id}`, { variants: [{ values: {}, price: 1 }] }), 409, "variant_has_stock");
  // A closed branch takes no goods in, and can still let them go.
  ok(await o.call("PUT", `/branches/${o.B}`, { active: false }));
  refused(await o.call("POST", "/stock/receive", { lines: [{ variantId: v, qty: 1 }], branchId: o.B }), 409, "branch_closed");
  ok(await o.call("POST", "/stock/write-off", { variantId: v, qty: 1, reason: "lost", branchId: o.B }));
  ok(await o.call("POST", "/stock/count", { variantId: v, counted: 0, branchId: o.B }));
  await ledgerHolds(o);
});

test("an order is filled from one branch: it holds and takes stock there, never another branch's", async () => {
  const o = await business();
  const p = await o.product({ opening: 5 }); // at A
  const v = p.variants[0].id;
  const atB = ok(await o.order({ lines: [{ variantId: v, qty: 2 }], branchId: o.B }), 201);
  assert.equal(atB.changes.set.orders[0].branchId, o.B);
  const short = refused(await o.call("POST", `/orders/${atB.id}/step`, { to: o.held }), 422, "rules");
  assert.deepEqual(short.hard, [{ code: "short", variantId: v, productId: p.id, name: "Roses", need: 2, free: 0, missing: 2 }], "A's five don't serve B's order");
  ok(await o.call("POST", "/stock/receive", { lines: [{ variantId: v, qty: 3 }], branchId: o.B }));
  const heldB = ok(await o.call("POST", `/orders/${atB.id}/step`, { to: o.held }));
  assert.deepEqual(heldB.changes.set.products[0].branches, { [o.A]: { stock: 5, reserved: 0 }, [o.B]: { stock: 3, reserved: 2 } });
  // Editing its lines checks B's shelf: one more is there, five more are not (A has them).
  ok(await o.call("PUT", `/orders/${atB.id}`, { lines: [{ variantId: v, qty: 3 }] }));
  assert.deepEqual(refused(await o.call("PUT", `/orders/${atB.id}`, { lines: [{ variantId: v, qty: 4 }] }), 422, "rules").hard[0].code, "short");
  const sold = ok(await o.call("POST", `/orders/${atB.id}/step`, { to: o.done }));
  assert.deepEqual(sold.changes.set.movements.map((m) => [m.type, m.qty, m.branchId]), [["sale", -3, o.B]]);
  assert.deepEqual(sold.changes.set.products[0].branches, { [o.A]: { stock: 5, reserved: 0 }, [o.B]: { stock: 0, reserved: 0 } });
  // An order at A holds at A.
  const atA = ok(await o.order({ lines: [{ variantId: v, qty: 4 }] }), 201);
  assert.equal(atA.changes.set.orders[0].branchId, o.A);
  ok(await o.call("POST", `/orders/${atA.id}/step`, { to: o.held }));
  assert.deepEqual((await o.snap("?only=products")).products[0].branches[o.A], { stock: 5, reserved: 4 });
  // Back from done: the goods return to B, where they were sold.
  const back = ok(await o.call("POST", `/orders/${atB.id}/cancel`, {}));
  assert.deepEqual(back.changes.set.movements.map((m) => [m.type, m.branchId]), [["return", o.B]]);
  await ledgerHolds(o);
  // A closed branch takes no new orders; its orders go on.
  ok(await o.call("PUT", `/branches/${o.B}`, { active: false }));
  refused(await o.order({ lines: [{ variantId: v, qty: 1 }], branchId: o.B }), 409, "branch_closed");
  const receipt = ok(await o.call("GET", `/orders/${atB.id}/receipt`));
  assert.deepEqual(receipt.business, { name: "Guldasta", branch: "Chilonzor", address: "Bunyodkor 1" });
});

test("moving goods: a pair of ledger lines, totals unchanged, never more than is free", async () => {
  const o = await business();
  const p = await o.product({ opening: 10 }); // at A
  const v = p.variants[0].id;
  const ord = ok(await o.order({ lines: [{ variantId: v, qty: 2 }] }), 201).id;
  ok(await o.call("POST", `/orders/${ord}/step`, { to: o.held })); // A: 10 on hand, 2 held
  const move = (body) => o.call("POST", "/stock/transfer", { fromBranchId: o.A, toBranchId: o.B, lines: [{ productId: p.id, qty: 5 }], ...body });
  const tooMuch = refused(await move({ lines: [{ variantId: v, qty: 9 }] }), 422, "rules");
  assert.deepEqual(tooMuch.hard, [{ code: "transfer_short", variantId: v, productId: p.id, name: "Roses", need: 9, free: 8, reserved: 2 }]);
  const r = ok(await move({ note: "For the weekend" }));
  assert.deepEqual(r.changes.set.movements.map((m) => [m.type, m.qty, m.branchId, m.fromBranchId, m.toBranchId, m.note]).sort((x, y) => x[1] - y[1]), [
    ["transfer", -5, o.A, o.A, o.B, "For the weekend"],
    ["transfer", 5, o.B, o.A, o.B, "For the weekend"],
  ]);
  const after = r.changes.set.products[0];
  assert.deepEqual([after.stock, after.reserved, after.branches], [10, 2, { [o.A]: { stock: 5, reserved: 2 }, [o.B]: { stock: 5, reserved: 0 } }], "the business's totals stay");
  await ledgerHolds(o);
  // The snapshot lists both lines; narrowed to B, only B's.
  assert.equal((await o.snap("?only=movements")).movements.filter((m) => m.type === "transfer").length, 2);
  assert.deepEqual((await o.snap(`?only=movements&branch=${o.B}`)).movements.map((m) => [m.type, m.qty]), [["transfer", 5]]);
  refused(await move({ toBranchId: o.A }), 400, "same_branch");
  assert.equal((await move({ lines: [] })).status, 400);
  // To a closed branch: no; from it: yes.
  ok(await o.call("PUT", `/branches/${o.B}`, { active: false }));
  refused(await move({ lines: [{ variantId: v, qty: 1 }] }), 409, "branch_closed");
  ok(await move({ fromBranchId: o.B, toBranchId: o.A, lines: [{ variantId: v, qty: 5 }] }));
  assert.deepEqual((await o.snap("?only=products")).products[0].branches, { [o.A]: { stock: 10, reserved: 2 }, [o.B]: { stock: 0, reserved: 0 } });
  await ledgerHolds(o);
});

test("moving goods under a race: the last items go once, totals never change, each branch is its ledger", async () => {
  const o = await business();
  const C = ok(await o.call("POST", "/branches", { name: "Sergeli" }), 201).id;
  const p = await o.product({ opening: 10 }); // at A
  const v = p.variants[0].id;
  const send = (from, to, qty) => o.call("POST", "/stock/transfer", { fromBranchId: from, toBranchId: to, lines: [{ variantId: v, qty }] });
  // Six moves of 3 out of A's 10 at once: three go, three are refused.
  const first = await Promise.all(Array.from({ length: 6 }, (_, i) => send(o.A, i % 2 ? o.B : C, 3)));
  assert.deepEqual(first.map((r) => r.status).sort(), [200, 200, 200, 422, 422, 422]);
  for (const r of first.filter((x) => x.status === 422)) assert.equal(r.body.hard[0].code, "transfer_short");
  await ledgerHolds(o);
  // Then every way at once, with receipts and sales mixed in.
  const mixed = await Promise.all([
    ...Array.from({ length: 5 }, () => send(o.B, o.A, 1)),
    ...Array.from({ length: 5 }, () => send(C, o.B, 1)),
    ...Array.from({ length: 5 }, () => send(o.A, C, 1)),
    o.call("POST", "/stock/receive", { lines: [{ variantId: v, qty: 2 }], branchId: C }),
    o.call("POST", "/stock/write-off", { variantId: v, qty: 1, reason: "damaged", branchId: o.A }),
  ]);
  assert.ok(mixed.every((r) => r.status === 200 || (r.status === 422 && r.body.hard[0].code.endsWith("short"))), JSON.stringify(mixed.filter((r) => r.status !== 200).map((r) => r.body)));
  const rows = await ledgerHolds(o);
  const total = rows.reduce((s, r) => s + r.on_hand, 0);
  const wroteOff = mixed.at(-1).status === 200 ? 1 : 0;
  assert.equal(total, 10 + 2 - wroteOff, "only the receipt and the write-off changed the total");
  const product = (await o.snap("?only=products")).products[0];
  assert.equal(product.stock, total);
  assert.deepEqual(Object.values(product.branches).reduce((s, b) => s + b.stock, 0), total);
});

test("a team member limited to one branch sees and changes only it", async () => {
  const o = await business();
  const mate = await teammate(o, "agent");
  const as = (method, path, body) => o.call(method, path, body, mate.b);
  const p = await o.product({ opening: 6 }); // at A
  const v = p.variants[0].id;
  ok(await o.call("POST", "/stock/receive", { lines: [{ variantId: v, qty: 4 }], branchId: o.B }));
  const orderA = ok(await o.order({ lines: [{ variantId: v, qty: 1 }] }), 201).id;
  const apptA = ok(await o.book({ staffId: o.pa }), 201).id;
  const apptB = ok(await o.book({ staffId: o.pb }), 201).id;
  const closedA = ok(await o.call("POST", "/time-off", { start: `${D(9)}T00:00`, end: `${D(9)}T23:59` }), 201).id;
  const limited = ok(await o.call("PUT", `/branches/members/${mate.user.id}`, { branchId: o.B }));
  assert.deepEqual(limited.changes.set.branches.map((b) => [b.id, b.members]), [[o.B, [mate.user.id]]]);

  // The snapshot: only B, B's people and bookings, B's stock numbers.
  const db = ok(await mate.b.call("GET", `${o.crm}/snapshot`));
  assert.deepEqual(db.branches.map((b) => b.id), [o.B]);
  assert.deepEqual(db.staff.map((x) => x.id), [o.pb]);
  assert.deepEqual(db.appointments.map((x) => x.id), [apptB]);
  assert.deepEqual([db.timeOff.length, db.orders.length], [0, 0]);
  assert.deepEqual([db.products[0].stock, "branches" in db.products[0]], [4, false]);
  assert.deepEqual([...new Set(db.movements.map((m) => m.branchId))], [o.B]);
  refused(await mate.b.call("GET", `${o.crm}/snapshot?branch=${o.A}`), 403, "other_branch");
  assert.equal(ok(await mate.b.call("GET", `${o.crm}/snapshot?only=staff&branch=${o.B}`)).staff.length, 1);
  assert.deepEqual(ok(await as("GET", `/customers/${o.c1}/history`)).appointments.map((a) => a.id), [apptB]);

  // Stock: their branch by default, never another.
  const got = ok(await as("POST", "/stock/receive", { lines: [{ variantId: v, qty: 1 }] }));
  assert.deepEqual([got.changes.set.movements[0].branchId, got.changes.set.products[0].stock, "branches" in got.changes.set.products[0]], [o.B, 5, false]);
  refused(await as("POST", "/stock/receive", { lines: [{ variantId: v, qty: 1 }], branchId: o.A }), 403, "other_branch");
  refused(await as("POST", "/stock/write-off", { variantId: v, qty: 1, reason: "lost", branchId: o.A }), 403, "other_branch");
  refused(await as("POST", "/stock/count", { variantId: v, counted: 0, branchId: o.A }), 403, "other_branch");
  refused(await as("POST", "/stock/transfer", { fromBranchId: o.B, toBranchId: o.A, lines: [{ variantId: v, qty: 1 }] }), 403, "other_branch");
  const opened = ok(await as("POST", "/products", { name: "Tulips", price: 1, opening: 2 }), 201);
  assert.equal(opened.changes.set.movements[0].branchId, o.B, "opening stock at their branch");
  // A product's new picture answers with their branch's numbers too.
  const form = new FormData();
  form.append("file", new Blob([Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex")], { type: "image/png" }), "a.png");
  const pictured = ok(await mate.b.call("POST", `${o.crm}/products/${p.id}/image`, form)).changes.set.products[0];
  assert.deepEqual([pictured.stock, "branches" in pictured], [5, false]);
  // Orders: made at B; A's can't be seen or changed.
  const mine = ok(await as("POST", "/orders", { customerId: o.c1, delivery: { type: "pickup" }, lines: [{ variantId: v, qty: 1 }] }), 201);
  assert.equal(mine.changes.set.orders[0].branchId, o.B);
  ok(await as("POST", `/orders/${mine.id}/step`, { to: o.held }));
  refused(await as("POST", "/orders", { customerId: o.c1, delivery: { type: "pickup" }, lines: [{ variantId: v, qty: 1 }], branchId: o.A }), 403, "other_branch");
  for (const [method, path, body] of [["POST", `/orders/${orderA}/step`, { to: o.held }], ["POST", `/orders/${orderA}/cancel`, {}], ["POST", `/orders/${orderA}/pay`, {}], ["PUT", `/orders/${orderA}`, { note: "x" }], ["GET", `/orders/${orderA}/receipt`]]) {
    assert.equal((await as(method, path, body)).status, 404, `${method} ${path}`);
  }
  // Bookings: B's specialists only; A's bookings and closed days are not theirs.
  refused(await o.book({ staffId: o.pa, start: `${D(3)}T10:00` }, mate.b), 403, "other_branch");
  assert.equal(ok(await o.book({ staffId: null, start: `${D(3)}T10:00` }, mate.b), 201).changes.set.appointments[0].staffId, o.pb, "anyone = anyone at B");
  refused(await o.book({ staffId: null, branchId: o.A, start: `${D(3)}T11:00` }, mate.b), 403, "other_branch");
  refused(await as("POST", `/appointments/${apptB}/move`, { staffId: o.pa }), 403, "other_branch");
  for (const [method, path, body] of [["PUT", `/appointments/${apptA}`, { note: "x" }], ["POST", `/appointments/${apptA}/step`, { status: "cancelled" }], ["POST", `/appointments/${apptA}/pay`, { paid: true }], ["POST", "/series", { appointmentId: apptA }], ["PUT", `/time-off/${closedA}`, { note: "x" }], ["DELETE", `/time-off/${closedA}`]]) {
    assert.equal((await as(method, path, body)).status, 404, `${method} ${path}`);
  }
  refused(await as("POST", "/time-off", { staffId: o.pa, start: `${D(5)}T10:00`, end: `${D(5)}T11:00` }), 403, "other_branch");
  refused(await as("POST", "/time-off", { start: `${D(5)}T00:00`, end: `${D(5)}T23:59`, branchId: o.A }), 403, "other_branch");
  assert.equal(ok(await as("POST", "/time-off", { start: `${D(6)}T00:00`, end: `${D(6)}T23:59` }), 201).changes.set.timeOff[0].branchId, o.B);
  refused(await as("POST", "/booking/check", { serviceIds: [o.s1], start: `${D(3)}T12:00`, staffId: o.pa }), 403, "other_branch");
  assert.equal(ok(await as("POST", "/booking/check", { serviceIds: [o.s1], start: `${D(3)}T12:00` })).staffId, o.pb);
  refused(await as("GET", `/booking/slots?day=${D(3)}&serviceIds=${o.s1}&branchId=${o.A}`), 403, "other_branch");
  await ledgerHolds(o);

  // An admin is never limited; let go, the member sees every branch again.
  const admin = await teammate(o, "admin", "Dilnoza");
  ok(await o.call("PUT", `/branches/members/${admin.user.id}`, { branchId: o.B }));
  assert.equal(ok(await admin.b.call("GET", `${o.crm}/snapshot?only=branches`)).branches.length, 2);
  ok(await o.call("PUT", `/branches/members/${mate.user.id}`, { branchId: null }));
  assert.equal(ok(await mate.b.call("GET", `${o.crm}/snapshot?only=branches`)).branches.length, 2);
  // A branch someone is limited to can't be deleted; only admins limit; a closed branch takes no one.
  const spare = ok(await o.call("POST", "/branches", { name: "Spare" }), 201).id;
  ok(await o.call("PUT", `/branches/members/${mate.user.id}`, { branchId: spare }));
  assert.equal(refused(await o.call("DELETE", `/branches/${spare}`), 409, "branch_in_use").uses, "members");
  assert.equal((await as("PUT", `/branches/members/${mate.user.id}`, { branchId: null })).status, 403);
  ok(await o.call("PUT", `/branches/members/${mate.user.id}`, { branchId: null }));
  ok(await o.call("PUT", `/branches/${spare}`, { active: false }));
  refused(await o.call("PUT", `/branches/members/${mate.user.id}`, { branchId: spare }), 409, "branch_closed");
  assert.equal((await o.call("PUT", `/branches/members/${o.c1}`, { branchId: o.B })).status, 404, "not a team member");
});

test("another workspace's branch is refused everywhere", async () => {
  const o = await business();
  const other = await crmOwner("Other Owner", "Other");
  const X = ok(await other.b.call("GET", `${other.crm}/snapshot?only=branches`)).branches[0].id;
  const p = await o.product({ opening: 3 });
  const v = p.variants[0].id;
  const tries = [
    ["POST", "/stock/receive", { lines: [{ variantId: v, qty: 1 }], branchId: X }],
    ["POST", "/stock/write-off", { variantId: v, qty: 1, reason: "lost", branchId: X }],
    ["POST", "/stock/count", { variantId: v, counted: 1, branchId: X }],
    ["POST", "/stock/transfer", { fromBranchId: o.A, toBranchId: X, lines: [{ variantId: v, qty: 1 }] }],
    ["POST", "/stock/transfer", { fromBranchId: X, toBranchId: o.A, lines: [{ variantId: v, qty: 1 }] }],
    ["POST", "/orders", { customerId: o.c1, delivery: { type: "pickup" }, lines: [{ variantId: v, qty: 1 }], branchId: X }],
    ["POST", "/staff", { name: "Spy", hours: ALL_DAY, branchId: X }],
    ["PUT", `/staff/${o.pa}`, { branchId: X }],
    ["POST", "/time-off", { start: `${D(5)}T00:00`, end: `${D(5)}T23:59`, branchId: X }],
    ["POST", "/appointments", { customerId: o.c1, serviceIds: [o.s1], start: `${D(2)}T10:00`, branchId: X }],
    ["POST", "/booking/check", { serviceIds: [o.s1], start: `${D(2)}T10:00`, branchId: X }],
    ["GET", `/booking/slots?day=${D(2)}&serviceIds=${o.s1}&branchId=${X}`],
    ["GET", `/snapshot?branch=${X}`],
  ];
  const mate = await teammate(o, "agent");
  ok(await o.call("PUT", `/branches/members/${mate.user.id}`, { branchId: o.A }));
  refused(await o.call("PUT", `/branches/members/${mate.user.id}`, { branchId: X }), 400, "bad_branch");
  for (const [method, path, body] of tries) refused(await o.call(method, path, body), 400, "bad_branch");
  for (const [method, path, body] of [["PUT", `/branches/${X}`, { name: "Mine" }], ["DELETE", `/branches/${X}`]]) assert.equal((await o.call(method, path, body)).status, 404);
  // Nothing of it was written there.
  const { rows } = await query("SELECT count(*)::int AS n FROM crm_stock_moves WHERE branch_id = $1", [X]);
  assert.equal(rows[0].n, 0);
  assert.equal(ok(await other.b.call("GET", `${other.crm}/snapshot?only=branches`)).branches[0].name, "");
  await ledgerHolds(o);
});

/* ───── Repeat bookings and branches ───── */

const visitAt = async (id) => (await query("SELECT branch_id, staff_id, status, to_char(start_at, 'HH24:MI') AS t FROM crm_appointments WHERE id = $1", [id])).rows[0];

test("repeat bookings: a member limited to one branch changes or stops only the visits at their branch", async () => {
  const o = await business();
  const mate = await teammate(o, "agent");
  ok(await o.call("PUT", `/branches/members/${mate.user.id}`, { branchId: o.A }));
  const first = ok(await o.book({ staffId: o.pa, start: `${D(1)}T10:00` }), 201).id;
  const s = ok(await o.call("POST", "/series", { appointmentId: first, every: 1 }), 201);
  assert.ok(s.created.length >= 2, "the series booked visits ahead");
  // One later visit, "only this one", goes to Bek at B.
  const [atB, ...rest] = s.created;
  ok(await o.call("POST", `/appointments/${atB}/move`, { staffId: o.pb }));
  const before = await visitAt(atB);
  assert.equal(before.branch_id, o.B);
  assert.equal((await o.call("POST", `/appointments/${atB}/pay`, { paid: true }, mate.b)).status, 404, "not theirs to open");

  // A change from the first day moves A's visits and leaves the one at B as it was.
  const ch = ok(await o.call("PUT", `/series/${s.id}`, { from: D(1), time: "15:00" }, mate.b));
  assert.ok(!ch.moved.includes(atB) && !(ch.changes.set.appointments || []).some((a) => a.id === atB), "the visit at B is not in the answer");
  assert.deepEqual(await visitAt(atB), before, "the visit at B is not moved");
  for (const id of [first, ...rest]) assert.equal((await visitAt(id)).t, "15:00", "A's visits follow the change");

  // Stopping the series cancels A's visits and leaves the one at B booked.
  const stop = ok(await o.call("POST", `/series/${s.id}/stop`, { from: D(1) }, mate.b));
  assert.ok(!stop.cancelled.includes(atB));
  assert.deepEqual(stop.cancelled.sort(), [first, ...rest].sort());
  assert.deepEqual(await visitAt(atB), before, "the visit at B is not cancelled");
});

test("repeat bookings: a series is where its specialist works; a member limited to another branch can't make one there", async () => {
  const o = await business();
  const mate = await teammate(o, "agent");
  ok(await o.call("PUT", `/branches/members/${mate.user.id}`, { branchId: o.A }));
  const first = ok(await o.book({ staffId: o.pa, start: `${D(1)}T10:00` }), 201).id;
  // Aziz moves to B; the booking made at A stays at A.
  ok(await o.call("PUT", `/staff/${o.pa}`, { branchId: o.B }));
  assert.equal((await visitAt(first)).branch_id, o.A);
  refused(await o.call("POST", "/series", { appointmentId: first, every: 1 }, mate.b), 403, "other_branch");
  assert.equal((await query("SELECT count(*)::int AS n FROM crm_series WHERE workspace_id = $1", [o.ws.id])).rows[0].n, 0, "nothing was made");
  // The admin may: the series and its new visits are at B, where Aziz works now; the first visit stays at A.
  const s = ok(await o.call("POST", "/series", { appointmentId: first, every: 1 }), 201);
  assert.equal(s.changes.set.series[0].branchId, o.B);
  const { rows } = await query("SELECT DISTINCT branch_id FROM crm_appointments WHERE id = ANY($1::uuid[])", [s.created]);
  assert.deepEqual(rows.map((r) => r.branch_id), [o.B]);
  assert.equal((await visitAt(first)).branch_id, o.A);
});

test("repeat bookings: a specialist who moves takes their running series along, and the answer says so", async () => {
  const o = await business();
  const first = ok(await o.book({ staffId: o.pa, start: `${D(1)}T10:00` }), 201).id;
  const s = ok(await o.call("POST", "/series", { appointmentId: first, every: 1 }), 201);
  // A series that ended stays where it was.
  const old = ok(await o.book({ staffId: o.pa, start: `${D(1)}T12:00` }), 201).id;
  const ended = ok(await o.call("POST", "/series", { appointmentId: old, every: 1 }), 201);
  ok(await o.call("POST", `/series/${ended.id}/stop`, { from: D(0) }));
  const r = ok(await o.call("PUT", `/staff/${o.pa}`, { branchId: o.B }));
  assert.deepEqual(r.changes.set.series.map((x) => [x.id, x.branchId]), [[s.id, o.B]], "the running series moves and is in the answer");
  assert.equal(r.ahead.count, s.created.length + 1, "its bookings ahead are reported, not moved");
  const at = async (id) => (await query("SELECT branch_id FROM crm_series WHERE id = $1", [id])).rows[0].branch_id;
  assert.deepEqual([await at(s.id), await at(ended.id)], [o.B, o.A]);
  for (const id of [first, ...s.created]) assert.equal((await visitAt(id)).branch_id, o.A, "booked visits stay where they were made");

  // New days of the series are booked at B, with the series, and a member at B can stop them.
  const ch = ok(await o.call("PUT", `/series/${s.id}`, { from: D(1), weekdays: [0, 1, 2, 3, 4, 5, 6] }));
  assert.ok(ch.created.length > 0);
  const { rows } = await query("SELECT DISTINCT branch_id FROM crm_appointments WHERE id = ANY($1::uuid[])", [ch.created]);
  assert.deepEqual(rows.map((x) => x.branch_id), [o.B]);
  const atB = await teammate(o, "agent", "Bmate");
  ok(await o.call("PUT", `/branches/members/${atB.user.id}`, { branchId: o.B }));
  const seen = ok(await atB.b.call("GET", `${o.crm}/snapshot?only=series,appointments`));
  assert.deepEqual(seen.series.map((x) => x.id), [s.id]);
  const stop = ok(await o.call("POST", `/series/${s.id}/stop`, { from: D(1) }, atB.b));
  assert.deepEqual(stop.cancelled.sort(), [...ch.created].sort(), "only the visits at B are cancelled");
  for (const id of [first, ...s.created]) assert.notEqual((await visitAt(id)).status, "cancelled");
});

test("opening stock is a receipt: a closed branch takes none, also for a member limited to it", async () => {
  const o = await business();
  const mate = await teammate(o, "agent");
  ok(await o.call("PUT", `/branches/members/${mate.user.id}`, { branchId: o.B }));
  ok(await o.call("PUT", `/branches/${o.B}`, { active: false }));
  refused(await o.call("POST", "/products", { name: "Roses", price: 1000, opening: 5 }, mate.b), 409, "branch_closed");
  // A product with no stock is fine: products are the business's, not a branch's.
  const size = { id: "size", name: "Size", values: ["S", "M"] };
  const p = ok(await o.call("POST", "/products", { name: "Tulips", options: [size], variants: [{ values: { size: "S" }, price: 1000 }] }, mate.b), 201).changes.set.products[0];
  const v = p.variants[0];
  refused(await o.call("POST", "/stock/receive", { lines: [{ productId: p.id, qty: 5 }] }, mate.b), 409, "branch_closed");
  refused(await o.call("PUT", `/products/${p.id}`, { variants: [{ id: v.id }, { values: { size: "M" }, price: 1000, opening: 3 }] }, mate.b), 409, "branch_closed");
  const { rows } = await query("SELECT count(*)::int AS n FROM crm_stock_moves WHERE workspace_id = $1 AND branch_id = $2", [o.ws.id, o.B]);
  assert.equal(rows[0].n, 0, "nothing came into the closed branch");
  // The admin's opening stock goes to the default branch, open as always.
  ok(await o.call("POST", "/products", { name: "Lilies", price: 1000, opening: 5 }), 201);
  await ledgerHolds(o);
});
