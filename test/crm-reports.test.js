// Reports through the API, checked against a hand-made business: bookings finished, paid, unpaid,
// missed and cancelled; orders with a part paid ahead, line and order discounts, a delivery fee,
// refunds, a return and an order cancelled before it was handed over; across the end of October,
// with a hand-over just after midnight on the business's clock. Everything is made through the
// API, then moved to fixed days with SQL (the API refuses days that have passed).
import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { crmOwner, teammate, query, base } from "./helpers/setup.js";
import { addDays, dayOf, nowIn } from "../src/crm/shared/time.js";

const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const D = (n) => addDays(dayOf(nowIn("Asia/Tashkent", new Date())), n);
const WORK = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, ["09:00", "18:00"]]));
const SPAN = "from=2026-10-31&to=2026-11-01";
const TZ = "Asia/Tashkent";

let o;
const ids = {};
const get = (path, b = o.b) => b.call("GET", `${o.crm}/reports/${path}`);
const post = async (path, body, status = 201) => ok(await o.b.call("POST", o.crm + path, body), status);
/** Puts a booking on a fixed moment of the business's clock. */
const redate = (id, at) => query("UPDATE crm_appointments SET start_at = $2 WHERE id = $1", [id, at]);
/** Puts an order's hand-over (its ledger lines of these types) and its payments of this sign at a fixed moment. */
const redateOrder = async (id, at, { moves = ["sale", "release", "reserve"], payments = "amount > 0" } = {}) => {
  await query(`UPDATE crm_stock_moves SET at = $2::timestamp AT TIME ZONE '${TZ}' WHERE order_id = $1 AND type = ANY($3::text[])`, [id, at, moves]);
  if (payments) await query(`UPDATE crm_payments SET at = $2::timestamp AT TIME ZONE '${TZ}' WHERE order_id = $1 AND ${payments}`, [id, at]);
};

/** The hand-made business, made once for all the tests of this file. */
let made;
const world = () => (made ||= build());
async function build() {
  o = await crmOwner();
  ok(await o.b.call("PUT", `${o.crm}/settings`, { modules: { booking: true, store: true } }));
  const snap = ok(await o.b.call("GET", `${o.crm}/snapshot`));
  const step = (list, kind) => snap[list].find((s) => s.kind === kind).id;
  ids.branch = snap.branches[0].id;

  // Customers: C1 and C2 have been around since October, C3 was added on the 31st.
  ids.c1 = (await post("/customers", { name: "Jasur", phone: "+998901110001", source: "telegram", tags: ["vip"] })).id;
  ids.c2 = (await post("/customers", { name: "Malika", phone: "+998901110002", source: "phone" })).id;
  ids.c3 = (await post("/customers", { name: "Dilnoza", source: "telegram", tags: ["vip"] })).id;
  await query("UPDATE crm_customers SET created_at = '2026-10-01 10:00'::timestamp AT TIME ZONE 'Asia/Tashkent' WHERE id = ANY($1::uuid[])", [[ids.c1, ids.c2]]);
  await query("UPDATE crm_customers SET created_at = '2026-10-31 10:00'::timestamp AT TIME ZONE 'Asia/Tashkent' WHERE id = $1", [ids.c3]);

  // Booking: two services, two specialists 09:00-18:00 with a break 13:00-14:00.
  ids.s1 = (await post("/services", { name: "Haircut", duration: 30, price: 50000 })).id;
  ids.s2 = (await post("/services", { name: { en: "Colour", ru: "Окрашивание", uz: "Boʻyash" }, duration: 60, price: 90000 })).id;
  const breaks = [{ from: "13:00", to: "14:00" }];
  ids.p1 = (await post("/staff", { name: "Aziz", hours: WORK, breaks, serviceIds: [ids.s1, ids.s2] })).id;
  ids.p2 = (await post("/staff", { name: "Bek", hours: WORK, breaks, serviceIds: [ids.s1, ids.s2] })).id;
  const book = async (n, body, at) => {
    const id = (await post("/appointments", { start: `${D(n)}T${at.slice(11)}`, ...body })).id;
    await redate(id, at);
    return id;
  };
  const stepTo = async (id, kind) => ok(await o.b.call("POST", `${o.crm}/appointments/${id}/step`, { status: step("apptStages", kind) }));
  ids.b1 = await book(1, { customerId: ids.c1, staffId: ids.p1, serviceIds: [ids.s1, ids.s2] }, "2026-10-31T10:00"); // 140 000, 90 min
  ids.b2 = await book(2, { customerId: ids.c2, staffId: ids.p1, serviceIds: [ids.s1], price: 45000 }, "2026-11-01T10:00"); // a discount
  ids.b3 = await book(3, { customerId: ids.c1, staffId: ids.p2, serviceIds: [ids.s1] }, "2026-11-01T11:00"); // done, then unpaid
  ids.b4 = await book(4, { customerId: ids.c3, staffId: ids.p2, serviceIds: [ids.s2] }, "2026-10-31T12:00"); // missed
  ids.b5 = await book(5, { customerId: ids.c2, staffId: ids.p1, serviceIds: [ids.s1] }, "2026-11-01T15:00"); // cancelled
  ids.b6 = await book(6, { customerId: ids.c1, staffId: ids.p1, serviceIds: [ids.s1] }, "2026-10-15T10:00"); // before the span
  ids.b7 = await book(7, { customerId: ids.c3, staffId: ids.p1, serviceIds: [ids.s1] }, "2026-11-02T10:00"); // after it
  for (const id of [ids.b1, ids.b2, ids.b3, ids.b6, ids.b7]) await stepTo(id, "done");
  ok(await o.b.call("POST", `${o.crm}/appointments/${ids.b3}/pay`, { paid: false }));
  await stepTo(ids.b4, "noshow");
  await stepTo(ids.b5, "cancelled");
  // Bek is away for the last two hours of Nov 1.
  await post("/time-off", { staffId: ids.p2, start: "2026-11-01T16:00", end: "2026-11-01T17:59" });

  // Store: roses (one variant), tulips in two colours, and vases nobody bought.
  const roses = (await post("/products", { name: "Roses", sku: "R-1", price: 100000, cost: 60000, lowAt: 48, opening: 50 })).changes.set.products[0];
  const tulips = (await post("/products", {
    name: "Tulips",
    options: [{ id: "c", name: "Colour", values: ["Red", "White"] }],
    variants: [{ values: { c: "Red" }, sku: "T-R", price: 30000, cost: 10000, opening: 50 }, { values: { c: "White" }, sku: "T-W", price: 40000, cost: 15000, opening: 50 }],
  })).changes.set.products[0];
  await post("/products", { name: "Vase", sku: "V-1", price: 20000, cost: 2000, opening: 5 });
  ids.roses = roses.id;
  ids.tulips = tulips.id;
  const [red, white] = tulips.variants;
  const order = async (body) => (await post("/orders", { delivery: { type: "pickup" }, ...body })).id;
  const toStep = async (id, kind) => ok(await o.b.call("POST", `${o.crm}/orders/${id}/step`, { to: step("orderStages", kind) }));
  // O1: 2 roses, 10 000 off the line, 20 000 off the order: 170 000. 50 000 paid ahead in October, the rest at hand-over on Oct 31.
  ids.o1 = await order({ customerId: ids.c1, lines: [{ productId: roses.id, qty: 2, discount: 10000 }], discount: 20000 });
  ok(await o.b.call("POST", `${o.crm}/orders/${ids.o1}/pay`, { amount: 50000 }));
  await query("UPDATE crm_payments SET at = '2026-10-20 12:00'::timestamp AT TIME ZONE 'Asia/Tashkent' WHERE order_id = $1", [ids.o1]);
  await toStep(ids.o1, "done");
  await redateOrder(ids.o1, "2026-10-31T12:00", { payments: "at > now() - interval '1 hour'" });
  // O2: 3 red, 1 white, 10 001 off the order, courier 30 000: 149 999. Handed over at 00:30 on Nov 1 (still Oct 31 in UTC). 25 000 back that evening.
  ids.o2 = await order({ customerId: ids.c2, lines: [{ variantId: red.id, qty: 3 }, { variantId: white.id, qty: 1 }], discount: 10001, delivery: { type: "courier", address: "Chilonzor 9" } });
  await toStep(ids.o2, "done");
  await redateOrder(ids.o2, "2026-11-01T00:30");
  ok(await o.b.call("POST", `${o.crm}/orders/${ids.o2}/refund`, { amount: 25000 }));
  await redateOrder(ids.o2, "2026-11-01T18:00", { moves: [], payments: "amount < 0" });
  // O3: paid ahead, cancelled before it was handed over, money given back: none of it counts.
  ids.o3 = await order({ customerId: ids.c3, lines: [{ productId: roses.id, qty: 1 }] });
  ok(await o.b.call("POST", `${o.crm}/orders/${ids.o3}/pay`, {}));
  ok(await o.b.call("POST", `${o.crm}/orders/${ids.o3}/cancel`, {}));
  ok(await o.b.call("POST", `${o.crm}/orders/${ids.o3}/refund`, {}));
  await redateOrder(ids.o3, "2026-10-31T15:00", { moves: [], payments: "true" });
  // O4: handed over on Oct 30, returned with all the money on Nov 1: only the refund and the returned rose fall in the span.
  ids.o4 = await order({ customerId: ids.c1, lines: [{ productId: roses.id, qty: 1 }] });
  await toStep(ids.o4, "done");
  await redateOrder(ids.o4, "2026-10-30T12:00");
  ok(await o.b.call("POST", `${o.crm}/orders/${ids.o4}/refund`, { returnGoods: true }));
  await redateOrder(ids.o4, "2026-11-01T12:00", { moves: ["return"], payments: "amount < 0" });
  // O5: handed over on Nov 2, after the span.
  ids.o5 = await order({ customerId: ids.c2, lines: [{ productId: roses.id, qty: 1 }] });
  await toStep(ids.o5, "done");
  await redateOrder(ids.o5, "2026-11-02T12:00");
}

test("income: by day and by month, refunds on their own line, across the month edge and midnight", async () => {
  await world();
  const day = ok(await get(`income?${SPAN}&by=day`));
  assert.deepEqual(day.rows, [
    { start: "2026-10-31", end: "2026-10-31", bookings: 140000, orders: 170000, refunds: 0, net: 310000 },
    { start: "2026-11-01", end: "2026-11-01", bookings: 45000, orders: 149999, refunds: 125000, net: 69999 },
  ]);
  assert.deepEqual(day.total, { bookings: 185000, orders: 319999, refunds: 125000, net: 379999 });
  const month = ok(await get(`income?${SPAN}&by=month`));
  assert.deepEqual(month.rows.map((r) => [r.start, r.end, r.net]), [["2026-10-31", "2026-10-31", 310000], ["2026-11-01", "2026-11-01", 69999]]);
  assert.deepEqual(month.total, day.total);
  // A week from Wednesday: the row starts on the span's first day, and empty days are rows too.
  const week = ok(await get("income?from=2026-10-28&to=2026-11-03&by=week"));
  assert.deepEqual(week.rows.map((r) => [r.start, r.end]), [["2026-10-28", "2026-11-01"], ["2026-11-02", "2026-11-03"]]);
  // Oct 28 to Nov 1 adds O4's hand-over on Oct 30 (100 000); Nov 2 adds B7 (50 000) and O5 (100 000).
  assert.deepEqual(week.rows.map((r) => r.net), [479999, 150000]);
  const empty = ok(await get("income?from=2026-12-01&to=2026-12-03"));
  assert.equal(empty.rows.length, 3);
  assert.deepEqual(empty.total, { bookings: 0, orders: 0, refunds: 0, net: 0 });

  // The sums are what the panels show: orders less refunds is what the orders say was paid.
  const snap = ok(await o.b.call("GET", `${o.crm}/snapshot?only=orders`));
  const paid = (id) => snap.orders.find((x) => x.id === id).totals.paid;
  assert.equal(paid(ids.o1), 170000);
  assert.equal(paid(ids.o2), 149999 - 25000);
  assert.equal(snap.orders.find((x) => x.id === ids.o2).totals.total, 149999);
});

test("bookings by what happened, and the no-show rate", async () => {
  await world();
  const r = ok(await get(`bookings?${SPAN}`));
  assert.equal(r.total, 5);
  assert.deepEqual(r.byKind, {
    pending: { count: 0, value: 0 },
    booked: { count: 0, value: 0 },
    here: { count: 0, value: 0 },
    done: { count: 3, value: 140000 + 45000 + 50000 },
    noshow: { count: 1, value: 90000 },
    cancelled: { count: 1, value: 50000 },
  });
  assert.equal(r.noShowRate, 0.25);
  // The workspace renames its steps and adds one: the numbers go by kind, not by id.
  const stages = ok(await o.b.call("GET", `${o.crm}/snapshot?only=apptStages`)).apptStages;
  ok(await o.b.call("PUT", `${o.crm}/settings`, { apptStages: [...stages.map((s) => ({ ...s, name: `${s.kind} step` })), { id: "waiting", name: "Waiting", tone: "", kind: "pending" }] }));
  assert.deepEqual(ok(await get(`bookings?${SPAN}`)).byKind.done.count, 3);
  assert.equal(ok(await get("bookings?from=2026-12-01&to=2026-12-01")).noShowRate, null);
});

test("services and specialists", async () => {
  await world();
  const s = ok(await get(`services?${SPAN}`)).services;
  assert.deepEqual(s.map(({ id, visits, paid, income, average }) => ({ id, visits, paid, income, average })), [
    { id: ids.s1, visits: 3, paid: 2, income: 50000 + 45000, average: 47500 },
    { id: ids.s2, visits: 1, paid: 1, income: 90000, average: 90000 },
  ]);
  assert.equal(s[1].name.ru, "Окрашивание");

  const t = ok(await get(`specialists?${SPAN}`)).specialists;
  const aziz = t.find((x) => x.id === ids.p1);
  const bek = t.find((x) => x.id === ids.p2);
  // Two days of 9 hours less a 1-hour break: 960 minutes. Aziz is booked 90 + 30 (the cancelled one frees its time).
  assert.deepEqual([aziz.visits, aziz.paid, aziz.income, aziz.workMinutes, aziz.bookedMinutes, aziz.bookedShare], [2, 2, 185000, 960, 120, 0.125]);
  // Bek: away 2 hours, booked 30 (the missed visit frees its time), finished one visit that is not paid.
  assert.deepEqual([bek.visits, bek.paid, bek.income, bek.workMinutes, bek.bookedMinutes, bek.bookedShare], [1, 0, 0, 840, 30, 0.0357]);
});

test("products: units, income after discounts, margin from cost, returns", async () => {
  await world();
  const p = ok(await get(`products?${SPAN}`)).products;
  assert.deepEqual(p.map(({ id, sold, income, margin, returned }) => ({ id, sold, income, margin, returned })), [
    { id: ids.roses, sold: 2, income: 170000, margin: 170000 - 2 * 60000, returned: 1 },
    { id: ids.tulips, sold: 4, income: 130000 - 10001, margin: 119999 - 3 * 10000 - 15000, returned: 0 },
  ]);
  // The order's 10 001 off is split by the lines' sums: 6 924 (with the rounding) and 3 077.
  assert.deepEqual(p[1].variants.map((v) => [v.sku, v.sold, v.income]), [["T-R", 3, 83076], ["T-W", 1, 36923]]);
  assert.deepEqual(p[1].variants[0].values, { c: "Red" });
});

test("stock: value at cost, running low, sitting still", async () => {
  await world();
  const s = ok(await get(`stock?${SPAN}`));
  // Roses 50 - 2 - 1 + 1 - 1 = 47, red tulips 47, white 49, vases 5.
  assert.equal(s.value, 47 * 60000 + 47 * 10000 + 49 * 15000 + 5 * 2000);
  assert.equal(s.units, 47 + 47 + 49 + 5);
  assert.deepEqual([s.low.count, s.low.items.map((i) => i.sku)], [1, ["R-1"]]);
  assert.deepEqual([s.still.count, s.still.items.map((i) => [i.sku, i.stock, i.value])], [1, [["V-1", 5, 10000]]]);
});

test("customers: added, came, came back, top by spend, by source and tag", async () => {
  await world();
  const c = ok(await get(`customers?${SPAN}`));
  assert.deepEqual([c.added, c.came, c.returning, c.firstTime], [1, 2, 1, 1]);
  // Jasur: visit 140 000 + order 170 000 - the 100 000 given back on Nov 1. Malika: 45 000 + 149 999 - 25 000.
  assert.deepEqual(c.top.map((x) => [x.id, x.spend]), [[ids.c1, 210000], [ids.c2, 169999]]);
  assert.deepEqual(c.bySource, [{ source: "telegram", added: 1, came: 1, spend: 210000 }, { source: "phone", added: 0, came: 1, spend: 169999 }]);
  assert.deepEqual(c.byTag, [{ tag: "vip", added: 1, came: 1, spend: 210000 }]);
});

// The tables that grow with the business's history. A report reads them by the span (or by the
// orders and customers the span holds), never from end to end.
const HISTORY = ["crm_customers", "crm_orders", "crm_order_lines", "crm_payments", "crm_stock_moves", "crm_appointments"];

/** Runs `fn` and answers the history tables any of the server's queries meanwhile read whole (a Seq Scan in its plan), as "table (label)". */
async function wholeReads(label, fn) {
  const found = new Set();
  const real = pg.Client.prototype.query;
  const walk = (node) => {
    if (node["Node Type"] === "Seq Scan" && HISTORY.includes(node["Relation Name"])) found.add(`${node["Relation Name"]} (${label})`);
    for (const child of node.Plans || []) walk(child);
  };
  pg.Client.prototype.query = function explained(text, params, cb) {
    if (typeof text === "string" && /^\s*(WITH|SELECT)\b/.test(text) && HISTORY.some((t) => text.includes(t))) {
      return real.call(this, `EXPLAIN (FORMAT JSON) ${text}`, params).then((r) => {
        walk(r.rows[0]["QUERY PLAN"][0].Plan);
        return real.call(this, text, params, cb);
      });
    }
    return real.call(this, text, params, cb);
  };
  try {
    await fn();
  } finally {
    pg.Client.prototype.query = real;
  }
  return [...found];
}

test("reports and exports read the span asked, never the whole history", async () => {
  const h = await crmOwner("History Owner", "Long History");
  ok(await h.b.call("PUT", `${h.crm}/settings`, { modules: { booking: true, store: true } }));
  const snap = ok(await h.b.call("GET", `${h.crm}/snapshot`));
  const add = async (path, body) => ok(await h.b.call("POST", h.crm + path, body), 201);
  const variant = (await add("/products", { name: "Roses", sku: "R", price: 1000, cost: 500, opening: 100000 })).changes.set.products[0].variants[0].id;
  const service = (await add("/services", { name: "Cut", duration: 30, price: 1000 })).id;
  const staff = (await add("/staff", { name: "A", hours: WORK, serviceIds: [service] })).id;
  const params = { w: h.ws.id, branch: snap.branches[0].id, done: snap.orderStages.find((s) => s.kind === "done").id, visit: snap.apptStages.find((s) => s.kind === "done").id };
  // Two years: 20,000 customers, 20,000 orders handed over and paid, 10,000 finished visits.
  await query(`INSERT INTO crm_customers (workspace_id, name, created_at) SELECT $1, 'C' || g, now() - (g % 730) * interval '1 day' FROM generate_series(1, 20000) g`, [params.w]);
  await query(
    `INSERT INTO crm_orders (workspace_id, branch_id, number, customer_id, status, created_at)
     SELECT $1, $2, 1000 + c.k, c.id, $3, now() - (c.k % 730) * interval '1 day'
       FROM (SELECT id, row_number() OVER (ORDER BY id) AS k FROM crm_customers WHERE workspace_id = $1) c`,
    [params.w, params.branch, params.done]
  );
  await query("INSERT INTO crm_order_lines (workspace_id, order_id, variant_id, qty, price) SELECT $1, id, $2, 1, 1000 FROM crm_orders WHERE workspace_id = $1", [params.w, variant]);
  await query("INSERT INTO crm_stock_moves (workspace_id, variant_id, branch_id, type, qty, at, order_id) SELECT $1, $2, $3, 'sale', -1, created_at, id FROM crm_orders WHERE workspace_id = $1", [params.w, variant, params.branch]);
  await query("INSERT INTO crm_payments (workspace_id, order_id, amount, at) SELECT $1, id, 1000, created_at FROM crm_orders WHERE workspace_id = $1", [params.w]);
  await query(
    `INSERT INTO crm_appointments (workspace_id, branch_id, customer_id, staff_id, service_ids, start_at, duration, price, status, paid)
     SELECT $1, $2, c.id, $3, ARRAY[$4::uuid], date_trunc('day', now()::timestamp) - (c.k % 700) * interval '1 day' + interval '9 hours' + (c.k / 700) * interval '30 minutes', 30, 1000, $5, true
       FROM (SELECT id, row_number() OVER (ORDER BY id) AS k FROM crm_customers WHERE workspace_id = $1) c WHERE c.k <= 10000`,
    [params.w, params.branch, staff, service, params.visit]
  );
  await query(`ANALYZE ${HISTORY.join(", ")}`);

  const span = `from=${D(-30)}&to=${D(0)}`;
  const answers = {};
  const reads = [];
  for (const r of ["income", "bookings", "services", "specialists", "products", "stock", "customers"]) {
    reads.push(...(await wholeReads(`${r} report`, async () => (answers[r] = ok(await h.b.call("GET", `${h.crm}/reports/${r}?${span}`))))));
  }
  for (const x of ["orders", "bookings"]) {
    reads.push(...(await wholeReads(`${x} export`, async () => {
      const res = await fetch(`${base}${h.crm}/export/${x}.xlsx?${span}`, { headers: { Cookie: h.b.cookie } });
      assert.equal(res.status, 200);
      await res.arrayBuffer();
    })));
  }
  assert.deepEqual(reads, []);
  // The answers are the span's: about one order and visit in 24 of each.
  assert.ok(answers.income.total.orders > 0 && answers.income.total.orders < 2000 * 1000, JSON.stringify(answers.income.total));
  assert.equal(answers.customers.came, answers.customers.returning + answers.customers.firstTime);
  assert.ok(answers.products.products[0].sold > 0);
});

test("branch, span checks, roles and tenancy", async () => {
  await world();
  assert.deepEqual(ok(await get(`income?${SPAN}&branch=${ids.branch}`)).total, ok(await get(`income?${SPAN}`)).total);
  const strange = await get(`income?${SPAN}&branch=00000000-0000-4000-8000-000000000000`);
  assert.deepEqual([strange.status, strange.body.code], [400, "bad_branch"]);
  const backwards = await get("bookings?from=2026-11-02&to=2026-11-01");
  assert.equal(backwards.status, 400);
  assert.equal(backwards.body.issues[0].params.code, "bad_span");
  assert.equal((await get("stock?from=2024-01-01&to=2026-11-01")).status, 400);
  assert.equal((await get("income?from=2026-11-01&to=2026-11-01&by=year")).status, 400);
  assert.equal((await get("customers?from=2026-11-01")).status, 400);

  const mate = await teammate(o, "agent");
  for (const path of ["income", "bookings", "services", "specialists", "products", "stock", "customers"]) {
    assert.equal((await get(`${path}?${SPAN}`, mate.b)).status, 403, path);
  }
  const admin = await teammate(o, "admin", "Admin Person");
  assert.equal((await get(`income?${SPAN}`, admin.b)).status, 200);

  // Another business sees only its own: nothing.
  const other = await crmOwner("Other Owner", "Other");
  const theirs = ok(await other.b.call("GET", `${other.crm}/reports/income?${SPAN}`));
  assert.equal(theirs.total.net, 0);
  assert.equal(ok(await other.b.call("GET", `${other.crm}/reports/stock?${SPAN}`)).units, 0);
  assert.equal((await other.b.call("GET", `${other.crm}/reports/income?${SPAN}&branch=${ids.branch}`)).body.code, "bad_branch");
});
