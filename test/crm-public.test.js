// The public API behind a business's own booking and shop pages (src/crm/public): settings and
// the address, every route, pages and modules off, the rules as a customer meets them (never
// forced), the races for one time and for the last item, tokens, limits, tenancy, and that no
// payload carries anything internal (exact keys).
// "Now" is the server's real clock in the workspace's time zone, so days are counted from today.
import assert from "node:assert/strict";
import { test } from "node:test";
import { crmOwner, teammate, browser, query, base } from "./helpers/setup.js";
import { nowIn, addDays, dayOf } from "../src/crm/shared/time.js";
import { slugProblem } from "../src/crm/public/rules.js";
import { cancelProblem } from "../src/crm/shared/booking.js";
import { deliveryTime, suggestDelivery } from "../src/crm/shared/delivery.js";
import { PICTURES_PER_IP } from "../src/crm/public/page-routes.js";
import { capped, LEFT_CAP } from "../src/crm/shared/store.js";
import { forCustomer } from "../src/crm/shared/customer.js";
import { openingOf } from "../src/crm/public/hours.js";

const today = () => dayOf(nowIn("Asia/Tashkent", new Date()));
const D = (n) => addDays(today(), n);
const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, ["00:00", "24:00"]]));
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const keys = (o) => Object.keys(o).sort();
const codes = (list) => (list || []).map((r) => r.code);
let seq = 0;

const PAGE = { booking: true, shop: true, description: { en: "Hair and beauty", ru: "Красота", uz: "Goʻzallik" }, phone: "71 200 00 00", address: "Tashkent, Amir Temur 1", languages: ["uz", "ru", "en"], paymentMethods: ["cash", "click"], deliveryMethods: ["courier", "pickup"] };

/**
 * A CRM workspace with both modules and both pages on: two services (one switched off), two
 * specialists who work around the clock, a product with stock. Returns helpers for its public API.
 */
async function business({ slug = `biz-${++seq}-${process.pid}`, page = {} } = {}) {
  const o = await crmOwner();
  const post = (path, body, status = 201) => o.b.call("POST", o.crm + path, body).then((r) => ok(r, status));
  const settings = (body) => o.b.call("PUT", `${o.crm}/settings`, body);
  ok(await settings({ modules: { booking: true, store: true }, serviceCategories: [{ id: "hair", name: "Hair" }], productCategories: [{ id: "care", name: "Care" }], settings: { publicPage: { ...PAGE, slug, ...page } } }));
  const s1 = (await post("/services", { name: "Haircut", duration: 30, price: 50000, category: "hair" })).id;
  const s2 = (await post("/services", { name: "Colour", duration: 60, price: 90000, active: false })).id;
  const p1 = (await post("/staff", { name: "Aziz", role: "Barber", tone: "t2", hours: ALL_DAY, serviceIds: [s1, s2] })).id;
  const p2 = (await post("/staff", { name: "Bek", hours: ALL_DAY, serviceIds: [s1] })).id;
  const visitor = browser();
  const pub = (method, path, body, b = visitor) => b.call(method, `/public/crm/${slug}${path}`, body);
  const snap = async (only) => ok(await o.b.call("GET", `${o.crm}/snapshot?only=${only}`));
  return { ...o, slug, post, settings, s1, s2, p1, p2, pub, visitor, snap };
}
const visit = (x, over = {}) => ({ serviceIds: [x.s1], staffId: x.p1, start: `${D(1)}T10:00`, name: "Dilnoza", phone: "+998 90 111 22 33", ...over });
async function product(x, over = {}) {
  return (await x.post("/products", { name: "Shampoo", sku: `S${++seq}`, price: 40000, cost: 15000, lowAt: 1, category: "care", opening: 5, ...over })).changes.set.products[0];
}
const order = (p, over = {}) => ({ lines: [{ productId: p.id, variantId: p.variants[0].id, qty: 1 }], name: "Madina", phone: "+998 93 444 55 66", delivery: { method: "pickup", date: D(2), window: { from: "12:00", to: "15:00" } }, payment: "cash", ...over });

/* ───── Pure rules ───── */

test("rules: the address, cancelling, the delivery time, what a reason may carry", () => {
  assert.equal(slugProblem(""), null);
  assert.equal(slugProblem("barber-bros"), null);
  for (const bad of ["ab", "Barber", "-x-y", "x--y", "a_b", "a".repeat(41), "bar ber"]) assert.deepEqual(slugProblem(bad), { code: "bad_slug" }, bad);
  assert.deepEqual(slugProblem("admin"), { code: "reserved_slug" });

  const stages = [{ id: "new", kind: "pending" }, { id: "ok", kind: "booked" }, { id: "here", kind: "here" }, { id: "x", kind: "cancelled" }];
  const rules = { cancelUntil: 120 };
  assert.equal(cancelProblem(stages, { status: "new", start: "2026-11-18T12:00" }, rules, "2026-11-18T10:00"), null);
  assert.deepEqual(cancelProblem(stages, { status: "ok", start: "2026-11-18T11:59" }, rules, "2026-11-18T10:00"), { code: "cancel_closed", minutes: 120 });
  assert.deepEqual(cancelProblem(stages, { status: "here", start: "2026-11-19T12:00" }, rules, "2026-11-18T10:00"), { code: "booking_closed" });

  const delivery = { time: "windows", windows: [{ from: "09:00", to: "12:00" }, { from: "12:00", to: "15:00" }] };
  assert.deepEqual(deliveryTime(delivery, { date: "2026-11-18", window: { from: "12:00", to: "15:00" } }, "2026-11-18T10:00"), { slot: "12:00–15:00", time: "" });
  assert.deepEqual(deliveryTime(delivery, { date: "2026-11-18", window: { from: "09:00", to: "12:00" } }, "2026-11-18T12:30").problem, { code: "bad_window" });
  assert.deepEqual(deliveryTime(delivery, { date: "2026-11-18", window: { from: "10:00", to: "11:00" } }, "2026-11-17T10:00").problem, { code: "bad_window" });
  assert.deepEqual(deliveryTime(delivery, { date: "2026-11-18", time: "14:20" }, "2026-11-17T10:00").problem, { code: "window_required" });
  assert.deepEqual(deliveryTime({ ...delivery, time: "exact" }, { date: "2026-11-18" }, "2026-11-17T10:00").problem, { code: "time_required" });
  assert.deepEqual(deliveryTime({ ...delivery, time: "both" }, { date: "2026-11-18", time: "14:20" }, "2026-11-17T10:00"), { slot: "", time: "14:20" });

  assert.deepEqual(forCustomer({ code: "taken", staffId: "x", id: "y", from: "10:00", to: "10:30" }), { code: "taken" });
  assert.deepEqual(forCustomer({ code: "closed", id: "y", start: "a", end: "b", note: "Inventory" }), { code: "closed" });
  assert.deepEqual(forCustomer({ code: "min_notice", minutes: 60 }), { code: "min_notice", minutes: 60 });
  assert.deepEqual([capped(-2), capped(3), capped(500)], [0, 3, LEFT_CAP]);
});

/* ───── Settings and the address ───── */

test("settings: publicPage is saved whole, checked, and the address belongs to one workspace", async () => {
  const x = await business();
  const saved = (await x.snap("settings")).settings.publicPage;
  assert.equal(saved.phone, "+998712000000", "the contact phone is kept in one form");
  assert.equal(saved.slug, x.slug);

  for (const [bad, code] of [["Bad Slug", "bad_slug"], ["admin", "reserved_slug"], ["a", "bad_slug"]]) {
    const r = await x.settings({ settings: { publicPage: { ...PAGE, slug: bad } } });
    assert.equal(r.status, 400, bad);
    assert.equal(r.body.issues[0].params.code, code, bad);
  }
  // Saved whole: a part of it is refused, as is a key it doesn't have.
  assert.equal((await x.settings({ settings: { publicPage: { slug: x.slug } } })).status, 400);
  assert.equal((await x.settings({ settings: { publicPage: { ...PAGE, slug: x.slug, colour: "red" } } })).status, 400);
  assert.equal((await x.settings({ settings: { publicPage: { ...PAGE, slug: x.slug, phone: "12" } } })).status, 400);

  // The settings tab asks before saving.
  const check = (o, slug) => o.b.call("GET", `${o.crm}/public/slug?slug=${encodeURIComponent(slug)}`).then((r) => ok(r));
  const y = await crmOwner("Other Owner", "Other");
  assert.deepEqual(await check(x, x.slug), { slug: x.slug, free: true, problem: null }, "its own address is free for it");
  assert.deepEqual(await check(y, x.slug), { slug: x.slug, free: false, problem: { code: "slug_taken" } });
  assert.deepEqual(await check(y, "www"), { slug: "www", free: false, problem: { code: "reserved_slug" } });
  assert.deepEqual(await check(y, "No"), { slug: "No", free: false, problem: { code: "bad_slug" } });
  assert.deepEqual(await check(y, `free-${x.slug}`), { slug: `free-${x.slug}`, free: true, problem: null });
  const member = await teammate(x, "agent");
  assert.equal((await member.b.call("GET", `${x.crm}/public/slug?slug=abc`)).status, 403);

  // The database keeps one workspace per address, whatever the timing.
  const taken = await y.b.call("PUT", `${y.crm}/settings`, { settings: { publicPage: { ...PAGE, slug: x.slug } } });
  assert.notEqual(taken.status, 200);
  assert.equal((await x.snap("settings")).settings.publicPage.slug, x.slug);
  assert.equal((await x.pub("GET", "/")).body.name, x.ws.name);
});

test("settings: an address several businesses save at once goes to one, the others hear slug_taken", async () => {
  const slug = `race-${++seq}-${process.pid}`;
  const owners = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => crmOwner(`Owner ${n}`, `Shop ${n}`)));
  const answers = await Promise.all(owners.map((o) => o.b.call("PUT", `${o.crm}/settings`, { settings: { publicPage: { ...PAGE, slug } } })));
  assert.deepEqual(answers.map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409], JSON.stringify(answers.map((r) => r.body)));
  for (const r of answers.filter((a) => a.status === 409)) assert.equal(r.body.code, "slug_taken");
});

/* ───── The front of the page ───── */

test("GET /: what the page draws itself with, and nothing else", async () => {
  const x = await business();
  const front = ok(await x.pub("GET", "/"));
  assert.deepEqual(keys(front), ["address", "booking", "cover", "description", "hours", "languages", "logo", "name", "now", "pages", "phone", "shop", "today"]);
  assert.deepEqual([front.cover, front.logo], ["", ""], "no pictures uploaded yet");
  assert.deepEqual(keys(front.hours), ["open", "opens", "until"]);
  assert.deepEqual(front.pages, { booking: true, shop: true });
  assert.deepEqual(front.booking, { maxDays: 30, cancelUntil: 120, step: 15 });
  assert.deepEqual(keys(front.shop), ["delivery", "deliveryMethods", "fields", "first", "firstTime", "paymentMethods"]);
  assert.deepEqual(keys(front.shop.delivery), ["closed", "daysOff", "maxDays", "prepMinutes", "sameDayUntil", "time", "windows"]);
  assert.deepEqual(front.shop.deliveryMethods.map(keys), [["address", "fee", "id", "name"], ["address", "fee", "id", "name"]]);
  assert.deepEqual(front.shop.paymentMethods.map((m) => m.id), ["cash", "click"]);
  assert.deepEqual(keys(front.shop.first), ["date", "slot", "time"]);
  assert.equal(front.today, today());
  // The business's day and time now, on its own clock.
  assert.match(front.now, /^\d{4}-\d\d-\d\dT\d\d:\d\d$/);
  assert.equal(front.now.slice(0, 10), front.today);
  assert.equal(front.phone, "+998712000000");
  // Windows and exact times both: the first window, and the first exact time too.
  const rules = (await x.snap("settings")).settings;
  assert.equal(rules.delivery.time, "both");
  assert.deepEqual(front.shop.first, suggestDelivery(rules.delivery, front.now, rules.dayStart));
  const exact = suggestDelivery(rules.delivery, front.now, rules.dayStart, { exact: true });
  assert.deepEqual(front.shop.firstTime, { date: exact.date, time: exact.time });
  assert.ok(front.shop.firstTime.time, "an exact time");
  ok(await x.settings({ settings: { delivery: { ...rules.delivery, time: "windows" } } }));
  assert.equal(ok(await x.pub("GET", "/")).shop.firstTime, null, "windows only: no exact time to offer");
  ok(await x.settings({ settings: { delivery: { ...rules.delivery, time: "exact" } } }));
  const onlyExact = ok(await x.pub("GET", "/")).shop;
  assert.deepEqual(onlyExact.firstTime, { date: onlyExact.first.date, time: onlyExact.first.time });
  ok(await x.settings({ settings: { delivery: rules.delivery } }));
  // No order fields yet: nothing to ask.
  assert.deepEqual(front.shop.fields, []);

  // A closed day's note is the business's own: the page gets the date only.
  const delivery = (await x.snap("settings")).settings.delivery;
  ok(await x.settings({ settings: { delivery: { ...delivery, closed: [{ date: D(3), note: "Stocktaking with the supplier" }] } } }));
  assert.deepEqual((await x.pub("GET", "/")).body.shop.delivery.closed, [D(3)]);
});

test("a page that is off, a module that is off and an unknown address answer the same 404", async () => {
  const x = await business();
  const notFound = async (path) => {
    const r = await x.pub("GET", path);
    assert.equal(r.status, 404, path);
    assert.deepEqual(r.body, { message: "Not found", code: "not_found" }, path);
  };
  const v = browser();
  const unknown = await v.call("GET", "/public/crm/nobody-has-this-one/");
  assert.deepEqual([unknown.status, unknown.body], [404, { message: "Not found", code: "not_found" }]);
  assert.equal((await v.call("GET", `/public/crm/${x.slug.toUpperCase()}/`)).status, 404);

  // The shop page off: its routes go, the booking page stays.
  ok(await x.settings({ settings: { publicPage: { ...PAGE, slug: x.slug, shop: false } } }));
  for (const path of ["/products", "/categories"]) await notFound(path);
  assert.equal((await x.pub("POST", "/orders", {})).status, 404, "a closed part answers before its input is read");
  assert.equal((await x.pub("POST", "/orders", order({ id: x.p1, variants: [{ id: x.p1 }] }))).status, 404);
  assert.deepEqual((await x.pub("GET", "/")).body.pages, { booking: true, shop: false });
  assert.equal((await x.pub("GET", "/")).body.shop, undefined);
  ok(await x.pub("GET", "/services"));

  // The Booking module off: the booking page goes too, though its switch is on.
  ok(await x.settings({ settings: { publicPage: { ...PAGE, slug: x.slug } } }));
  ok(await x.settings({ modules: { booking: false, store: true } }));
  for (const path of ["/services", `/slots?day=${D(1)}&serviceIds=${x.s1}`, `/days?month=${D(1).slice(0, 7)}&serviceIds=${x.s1}`]) await notFound(path);
  assert.equal((await x.pub("POST", "/bookings", visit(x))).status, 404);
  ok(await x.pub("GET", "/products"));

  // Both off: the address answers as if it were unknown.
  ok(await x.settings({ modules: { booking: false, store: false } }));
  await notFound("/");
  ok(await x.settings({ modules: { booking: true, store: true }, settings: { publicPage: { ...PAGE, slug: "" } } }));
  assert.equal((await v.call("GET", `/public/crm/${x.slug}/`)).status, 404, "no address, no page");
});

test("a page with both parts off answers exactly like an unknown address, on every path and before any input is read", async () => {
  const off = await business({ page: { booking: false, shop: false } });
  const p = await product(off);
  const window = { from: "12:00", to: "15:00" };
  const tries = [
    ["GET", "/"],
    ["GET", "/services"],
    ["GET", "/slots"],
    ["GET", `/slots?day=${D(1)}&serviceIds=${off.s1}`],
    ["GET", "/days"],
    ["POST", "/bookings", {}],
    ["POST", "/bookings", visit(off, { url: "x" })],
    ["GET", "/bookings/ABCDEFGH"],
    ["POST", "/bookings/ABCDEFGH/cancel", {}],
    ["GET", "/products"],
    ["GET", "/categories"],
    ["GET", "/images/x.png"],
    ["POST", "/orders", {}],
    ["POST", "/orders", order(p, { url: "x", delivery: { method: "pickup", date: D(2), window } })],
    ["GET", "/orders/ABCDEFGH"],
    ["GET", "/zzz"],
    ["POST", "/", {}],
  ];
  const answers = async (slug) => {
    const out = [];
    for (const [method, path, body] of tries) {
      const r = await browser().call(method, `/public/crm/${slug}${path}`, body);
      out.push([method, path, r.status, r.body]);
    }
    return out;
  };
  const closed = await answers(off.slug);
  for (const [method, path, status, body] of closed) assert.deepEqual([status, body], [404, { message: "Not found", code: "not_found" }], `${method} ${path}`);
  assert.deepEqual(closed, await answers(`nobody-${off.slug}`));
  assert.deepEqual((await off.snap("appointments,orders")).orders, [], "the honeypot never ran");

  // An open page: a path it doesn't have is the same 404.
  const x = await business();
  for (const [method, path] of [["GET", "/zzz"], ["POST", "/bookings/x/y"], ["GET", "/bookings"]]) {
    const r = await x.pub(method, path, method === "POST" ? {} : undefined, browser());
    assert.deepEqual([r.status, r.body], [404, { message: "Not found", code: "not_found" }], `${method} ${path}`);
  }
});

/* ───── Booking ───── */

test("booking catalogue: switched-on services with who does them; specialists by name, role and tone only", async () => {
  const x = await business();
  // Someone switched off doesn't show, nor a service nobody switched on does.
  const p3 = (await x.post("/staff", { name: "Off", hours: ALL_DAY, serviceIds: [x.s1], active: false })).id;
  const s3 = (await x.post("/services", { name: "Nobody", duration: 30, price: 1 })).id;
  const c = ok(await x.pub("GET", "/services"));
  assert.deepEqual(keys(c), ["categories", "fields", "services", "staff"]);
  assert.deepEqual(c.fields, [], "no booking field the business needs");
  assert.deepEqual(c.categories, [{ id: "hair", name: "Hair" }]);
  assert.deepEqual(c.services, [{ id: x.s1, name: "Haircut", category: "hair", duration: 30, price: 50000, staffIds: [x.p1, x.p2] }]);
  assert.deepEqual(c.staff, [{ id: x.p1, name: "Aziz", role: "Barber", tone: "t2" }, { id: x.p2, name: "Bek", role: "", tone: "t1" }]);
  assert.ok(!JSON.stringify(c).includes(p3) && !JSON.stringify(c).includes(s3));
});

test("slots and days: exactly what a customer may be offered", async () => {
  const x = await business();
  const day = D(3);
  const slots = ok(await x.pub("GET", `/slots?day=${day}&serviceIds=${x.s1}&staffId=${x.p1}`));
  assert.deepEqual(keys(slots), ["day", "duration", "none", "slots"]);
  assert.equal(slots.duration, 30);
  assert.equal(slots.slots.length, (24 * 60 - 30) / 15 + 1, "every 15 minutes all day");
  assert.deepEqual(slots.slots[0], { time: "00:00", staffId: x.p1 });
  assert.deepEqual(keys(slots.slots[0]), ["staffId", "time"]);

  // A booking takes its time, and the rules' grid holds for customers.
  ok(await x.pub("POST", "/bookings", visit(x, { start: `${day}T10:00` })), 201);
  const after = ok(await x.pub("GET", `/slots?day=${day}&serviceIds=${x.s1}&staffId=${x.p1}`)).slots.map((s) => s.time);
  assert.ok(!after.includes("10:00") && !after.includes("09:45") && !after.includes("10:15") && after.includes("10:30") && after.includes("09:30"));
  // Anyone: the time goes to whoever is free.
  const anyone = ok(await x.pub("GET", `/slots?day=${day}&serviceIds=${x.s1}`)).slots.find((s) => s.time === "10:00");
  assert.equal(anyone.staffId, x.p2);

  // Past the furthest day: none, with the reason in a code.
  const far = ok(await x.pub("GET", `/slots?day=${D(40)}&serviceIds=${x.s1}`));
  assert.deepEqual([far.slots, far.none], [[], { code: "max_days", days: 30 }]);
  // A closed day says so, without the team's note.
  await x.post("/time-off", { start: `${D(2)}T00:00`, end: `${D(2)}T23:59`, note: "Owner's wedding" });
  const closed = ok(await x.pub("GET", `/slots?day=${D(2)}&serviceIds=${x.s1}`));
  assert.deepEqual(closed.none, { code: "closed" });

  // Only what the page offers can be asked about.
  assert.equal((await x.pub("GET", `/slots?day=${D(1)}&serviceIds=${x.s2}`)).body.code, "bad_service", "a switched-off service");
  assert.equal((await x.pub("GET", `/slots?day=${D(1)}&serviceIds=${x.s1}&staffId=${x.s1}`)).body.code, "bad_staff");
  assert.equal((await x.pub("GET", `/slots?day=nope&serviceIds=${x.s1}`)).status, 400);

  // Days: from today up to maxDays, without the closed one.
  const month = day.slice(0, 7);
  const days = ok(await x.pub("GET", `/days?month=${month}&serviceIds=${x.s1}`));
  assert.deepEqual(keys(days), ["days", "month"]);
  assert.ok(days.days.includes(day) && !days.days.includes(D(2)));
  assert.ok(days.days.every((d) => d >= today() && d <= D(30) && d.startsWith(month)));
  assert.deepEqual(ok(await x.pub("GET", `/days?month=2020-01&serviceIds=${x.s1}`)).days, []);
  assert.equal((await x.pub("GET", `/days?month=2026-13&serviceIds=${x.s1}`)).status, 400);
});

test("booking: as a customer, in the first step, from the website; the phone finds or adds the customer and the answer never says which", async () => {
  const x = await business();
  await x.post("/customers", { name: "Jasur Karimov", phone: "+998901112233" });
  const known = ok(await x.pub("POST", "/bookings", visit(x, { name: "Someone Else", note: "<script>alert(1)</script>\nsecond line" })), 201);
  const fresh = ok(await x.pub("POST", "/bookings", visit(x, { phone: "+998 97 000 11 22", name: "  New   Person ", start: `${D(1)}T11:00` })), 201);
  for (const answer of [known, fresh]) {
    assert.deepEqual(keys(answer), ["ref", "token"]);
    assert.match(answer.ref, /^[A-HJKMNP-Z2-9]{8}$/);
    assert.ok(answer.token.length >= 32);
  }

  const s = await x.snap("appointments,customers");
  const jasur = s.customers.find((c) => c.phone === "+998901112233");
  assert.equal(jasur.name, "Jasur Karimov", "a known customer keeps their name");
  const added = s.customers.find((c) => c.phone === "+998970001122");
  assert.deepEqual([added.name, added.source], ["New Person", "website"]);
  const [a1, a2] = s.appointments;
  assert.deepEqual([a1.customerId, a1.status, a1.source, a1.staffId, a1.duration, a1.price], [jasur.id, "new", "website", x.p1, 30, 50000]);
  assert.equal(a1.note, "<script>alert(1)</script>\nsecond line", "kept as text, as it was typed");
  assert.equal(a2.customerId, added.id);

  // What the customer sees.
  const seen = ok(await x.pub("GET", `/bookings/${known.ref}?token=${known.token}`)).booking;
  assert.deepEqual(keys(seen), ["canCancel", "cancelBy", "duration", "price", "ref", "services", "specialist", "start", "step"]);
  assert.deepEqual(seen.step, { name: { en: "New", ru: "Новая", uz: "Yangi" }, kind: "pending" });
  assert.deepEqual(seen.specialist, { id: x.p1, name: "Aziz", role: "Barber", tone: "t2" });
  assert.deepEqual(seen.services, [{ id: x.s1, name: "Haircut" }]);
  assert.equal(seen.cancelBy, `${D(1)}T08:00`);
  assert.equal(seen.canCancel, true);
  // The team confirms it: the customer sees the business's own step name.
  ok(await x.b.call("POST", `${x.crm}/appointments/${a1.id}/step`, { status: "confirmed" }));
  assert.deepEqual(ok(await x.pub("GET", `/bookings/${known.ref.toLowerCase()}?token=${known.token}`)).booking.step.kind, "booked");

  // Anyone: the first specialist free then.
  const any = ok(await x.pub("POST", "/bookings", visit(x, { staffId: null, start: `${D(1)}T10:00`, phone: "+998 97 000 11 23" })), 201);
  assert.equal(ok(await x.pub("GET", `/bookings/${any.ref}?token=${any.token}`)).booking.specialist.id, x.p2);
});

test("booking fields the business needs: listed for the page, saved when given, marked for the team when not", async () => {
  const x = await business();
  ok(await x.settings({ fields: { appointment: [{ id: "allergy", name: "Allergies", type: "text", required: true }, { id: "room", name: "Room", type: "number" }, { id: "deposit", name: "Deposit taken", type: "yesno" }, { id: "staffnote", name: "Staff note", type: "text" }] } }));
  assert.deepEqual(ok(await x.pub("GET", "/services")).fields, [{ id: "allergy", name: "Allergies", type: "text" }], "only the ones it needs, without the team's own");
  // The team's own fields are not the customer's to fill: what the page sends for them is left out.
  ok(await x.pub("POST", "/bookings", visit(x, { fields: { allergy: "None", room: 4, deposit: true, staffnote: "VIP, free of charge" } })), 201);
  ok(await x.pub("POST", "/bookings", visit(x, { start: `${D(1)}T11:00`, phone: "+998 90 111 22 34" })), 201);
  assert.equal((await x.pub("POST", "/bookings", visit(x, { start: `${D(1)}T12:00`, phone: "+998 90 111 22 35", fields: { allergy: 5 } }))).body.code, "bad_fields");
  const [given, left] = (await x.snap("appointments")).appointments;
  assert.deepEqual([given.fields, given.history], [{ allergy: "None" }, []]);
  // Who made it: the customer, on the page.
  assert.deepEqual(given.createdBy, { by: "", byId: null, customer: true, via: "page" });
  assert.deepEqual(left.fields, {});
  assert.deepEqual(left.history, [{ at: left.history[0].at, by: "", byId: null, type: "missing", fields: ["allergy"], customer: true, via: "page" }], "the team sees what to ask");
  // The team still has to fill them in itself.
  assert.equal((await x.b.call("POST", `${x.crm}/appointments`, { customerId: left.customerId, serviceIds: [x.s1], start: `${D(2)}T10:00` })).body.code, "missing_fields");
});

test("booking rules bind customers, and nothing can force them", async () => {
  const x = await business();
  // Each try from its own address, so the per-address limit stays out of it.
  const book = (body) => x.pub("POST", "/bookings", visit(x, body), browser());
  const refused = async (body, code) => {
    const r = await book(body);
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.code, "rules");
    assert.ok([...codes(r.body.hard), ...codes(r.body.soft)].includes(code), `${code}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.override, undefined);
    return r.body;
  };
  await refused({ start: `${D(1)}T10:05` }, "off_grid");
  await refused({ start: `${D(40)}T10:00` }, "max_days");
  await refused({ start: `${D(-1)}T10:00` }, "day_passed");
  // A break and time off are the business's rules: the team may book over them, a customer never.
  ok(await x.b.call("PUT", `${x.crm}/staff/${x.p1}`, { breaks: [{ from: "13:00", to: "14:00" }] }));
  await refused({ start: `${D(1)}T13:00` }, "break");
  await x.post("/time-off", { staffId: x.p1, start: `${D(1)}T15:00`, end: `${D(1)}T16:00`, note: "Doctor" });
  const away = await refused({ start: `${D(1)}T15:00` }, "away");
  assert.deepEqual(away.soft.find((r) => r.code === "away"), { code: "away" }, "the specialist's note stays inside");
  // Taken: the other booking's id and times stay inside.
  ok(await book({ start: `${D(1)}T10:00` }), 201);
  const taken = await refused({ start: `${D(1)}T10:15`, phone: "+998 90 999 88 77" }, "taken");
  assert.deepEqual(taken.hard, [{ code: "taken" }]);
  // There is no force for customers, and no way to set the price, length or step.
  for (const extra of [{ force: true }, { price: 1 }, { duration: 300 }, { status: "confirmed" }, { source: "phone" }, { customerId: x.p1 }]) {
    assert.equal((await book({ start: `${D(1)}T13:00`, ...extra })).status, 400, JSON.stringify(extra));
  }
  // Bad input.
  for (const bad of [{ phone: "12345" }, { name: "" }, { name: "x".repeat(81) }, { note: "x".repeat(501) }, { serviceIds: [] }, { start: "tomorrow" }]) {
    assert.equal((await book({ start: `${D(1)}T11:00`, ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await book({ serviceIds: [x.s2], start: `${D(1)}T11:00` })).body.code, "bad_service");
  // Three days' notice: tomorrow is too soon.
  ok(await x.settings({ settings: { rules: { minNotice: 3 * 1440, maxDays: 30, cancelUntil: 120, buffer: 0, step: 15, override: true } } }));
  assert.deepEqual((await refused({ start: `${D(1)}T11:00` }, "min_notice")).soft, [{ code: "min_notice", minutes: 4320 }]);
});

test("two customers ask for the same time at once: exactly one gets it", async () => {
  const x = await business();
  const a = browser();
  const b = browser();
  const [r1, r2] = await Promise.all([
    x.pub("POST", "/bookings", visit(x, { start: `${D(2)}T12:00`, phone: "+998 90 000 00 01" }), a),
    x.pub("POST", "/bookings", visit(x, { start: `${D(2)}T12:15`, phone: "+998 90 000 00 02" }), b),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [201, 422], JSON.stringify([r1.body, r2.body]));
  assert.deepEqual((r1.status === 422 ? r1 : r2).body.hard, [{ code: "taken" }]);
  const { appointments } = await x.snap("appointments");
  assert.equal(appointments.length, 1);
});

test("a booking's token: required, its own, and the same every time; cancelling honours cancelUntil", async () => {
  const x = await business();
  const mine = ok(await x.pub("POST", "/bookings", visit(x)), 201);
  const other = ok(await x.pub("POST", "/bookings", visit(x, { start: `${D(1)}T12:00`, phone: "+998 90 555 44 33" })), 201);
  const look = (ref, token) => x.pub("GET", `/bookings/${ref}${token === undefined ? "" : `?token=${encodeURIComponent(token)}`}`);
  for (let i = 0; i < 3; i++) ok(await look(mine.ref, mine.token));
  assert.equal((await look(mine.ref)).status, 400, "no token");
  for (const [ref, token] of [[mine.ref, other.token], [mine.ref, mine.token.slice(0, -1)], [mine.ref, "x".repeat(200)], ["ZZZZZZZZ", mine.token], ["../../x", mine.token]]) {
    const r = await look(ref, token);
    assert.ok(r.status === 404 || r.status === 400, `${ref} ${token}`);
    if (r.status === 404) assert.deepEqual(r.body, { message: "Not found", code: "not_found" });
  }
  // A booking's reference is not an order's.
  assert.equal((await x.pub("GET", `/orders/${mine.ref}?token=${mine.token}`)).status, 404);
  // Only the hash is kept.
  const { rows } = await query("SELECT token_hash FROM crm_public_requests WHERE workspace_id = $1 AND ref = $2", [x.ws.id, mine.ref]);
  assert.ok(!rows[0].token_hash.toString("latin1").includes(mine.token) && rows[0].token_hash.length === 32);

  // Cancelling: the token is needed, and inside the cutoff only the team can change it.
  assert.equal((await x.pub("POST", `/bookings/${mine.ref}/cancel`, { token: other.token })).status, 404);
  // Cancel until three days before: tomorrow's visit can't be cancelled by the customer any more.
  ok(await x.settings({ settings: { rules: { minNotice: 0, maxDays: 30, cancelUntil: 3 * 1440, buffer: 0, step: 15, override: true } } }));
  const near = ok(await x.pub("POST", "/bookings", visit(x, { start: `${D(1)}T06:00`, staffId: x.p2, phone: "+998 90 555 44 34" })), 201);
  const r = await x.pub("POST", `/bookings/${near.ref}/cancel`, { token: near.token });
  assert.deepEqual([r.status, r.body.code, r.body.hard], [422, "rules", [{ code: "cancel_closed", minutes: 4320 }]]);
  assert.deepEqual([ok(await look(near.ref, near.token)).booking.canCancel, ok(await look(near.ref, near.token)).booking.cancelBy], [false, `${D(-2)}T06:00`]);
  ok(await x.settings({ settings: { rules: { minNotice: 60, maxDays: 30, cancelUntil: 120, buffer: 0, step: 15, override: true } } }));

  const done = ok(await x.pub("POST", `/bookings/${mine.ref}/cancel`, { token: mine.token }));
  assert.deepEqual(keys(done), ["booking"], "the write's changes stay with the host");
  assert.deepEqual(done.booking.step, { name: { en: "Cancelled", ru: "Отменена", uz: "Bekor qilingan" }, kind: "cancelled" });
  assert.equal(done.booking.canCancel, false);
  const again = await x.pub("POST", `/bookings/${mine.ref}/cancel`, { token: mine.token });
  assert.deepEqual([again.status, again.body.hard], [422, [{ code: "booking_closed" }]]);
  // The team sees it cancelled, its time free, and who did it in its history.
  const a = (await x.snap("appointments")).appointments.find((v) => v.start === `${D(1)}T10:00`);
  assert.equal(a.status, "cancelled");
  assert.deepEqual(a.history.at(-1), { at: a.history.at(-1).at, by: "", byId: null, type: "status", from: "new", to: "cancelled", reason: "", customer: true, via: "page" });
  ok(await x.pub("POST", "/bookings", visit(x, { phone: "+998 90 555 44 35" })), 201);
});

test("one phone makes at most three bookings a day; one it cancelled doesn't count", async () => {
  const x = await business();
  const made = [];
  for (const hour of ["10", "11", "12"]) made.push(ok(await x.pub("POST", "/bookings", visit(x, { start: `${D(1)}T${hour}:00` }), browser()), 201));
  const fourth = await x.pub("POST", "/bookings", visit(x, { start: `${D(1)}T13:00`, phone: "90 111 22 33" }), browser());
  assert.deepEqual([fourth.status, fourth.body.code], [429, "phone_limit"]);
  ok(await x.pub("POST", `/bookings/${made[0].ref}/cancel`, { token: made[0].token }));
  ok(await x.pub("POST", "/bookings", visit(x, { start: `${D(1)}T13:00` }), browser()), 201);
  // Another phone is not held back.
  ok(await x.pub("POST", "/bookings", visit(x, { start: `${D(1)}T14:00`, phone: "+998 90 111 22 34" }), browser()), 201);
});

test("the honeypot: an answer that looks real, and nothing saved", async () => {
  const x = await business();
  const fake = ok(await x.pub("POST", "/bookings", visit(x, { url: "http://spam.example" })), 201);
  assert.deepEqual(keys(fake), ["ref", "token"]);
  assert.equal((await x.pub("GET", `/bookings/${fake.ref}?token=${fake.token}`)).status, 404);
  const p = await product(x);
  ok(await x.pub("POST", "/orders", order(p, { url: "x" })), 201);
  const s = await x.snap("appointments,orders,customers");
  assert.deepEqual([s.appointments.length, s.orders.length, s.customers.length], [0, 0, 0]);
});

/* ───── Shop ───── */

test("catalogue: what is on sale, whether each variant is there and a capped count; never cost, SKU or stock", async () => {
  const x = await business();
  const plain = await product(x, { opening: 3 });
  const many = await product(x, { name: "Towel", opening: 50 });
  await product(x, { name: "Hidden", onSale: false });
  const shirt = (await x.post("/products", { name: "Shirt", options: [{ id: "size", name: "Size", values: ["S", "M"] }], variants: [{ values: { size: "S" }, price: 90000, opening: 2 }, { values: { size: "M" }, price: 95000 }] })).changes.set.products[0];
  const c = ok(await x.pub("GET", "/products"));
  assert.deepEqual(keys(c), ["products"]);
  assert.deepEqual(c.products.map((p) => p.name).sort(), ["Shampoo", "Shirt", "Towel"]);
  for (const p of c.products) {
    assert.deepEqual(keys(p), ["category", "description", "id", "image", "images", "name", "options", "unit", "variants"]);
    for (const v of p.variants) assert.deepEqual(keys(v), ["available", "id", "left", "price", "values"]);
  }
  const find = (id) => c.products.find((p) => p.id === id);
  assert.deepEqual(find(plain.id).variants, [{ id: plain.variants[0].id, values: {}, price: 40000, available: true, left: 3 }]);
  assert.equal(find(many.id).variants[0].left, LEFT_CAP);
  assert.deepEqual(find(plain.id).unit, { en: "pcs", ru: "шт", uz: "dona" });
  assert.deepEqual(find(shirt.id).options, [{ id: "size", name: "Size", values: ["S", "M"] }]);
  assert.deepEqual(find(shirt.id).variants.map((v) => [v.values.size, v.available, v.left]), [["S", true, 2], ["M", false, 0]]);
  assert.deepEqual(ok(await x.pub("GET", "/categories")), { categories: [{ id: "care", name: "Care" }] });
});

test("ordering: the customer's delivery rules, the page's methods, in the first open step from the website", async () => {
  const x = await business();
  const p = await product(x);
  const made = ok(await x.pub("POST", "/orders", order(p, { note: "Ring the bell" })), 201);
  assert.deepEqual(keys(made), ["ref", "token"]);
  const s = await x.snap("orders,customers");
  const [o] = s.orders;
  assert.deepEqual([o.status, o.source, o.payment, o.delivery.type, o.delivery.slot, o.note, o.lines[0].qty, o.lines[0].price], ["new", "website", "cash", "pickup", "12:00–15:00", "Ring the bell", 1, 40000]);
  assert.deepEqual([s.customers[0].name, s.customers[0].phone, s.customers[0].source], ["Madina", "+998934445566", "website"]);

  const seen = ok(await x.pub("GET", `/orders/${made.ref}?token=${made.token}`)).order;
  assert.deepEqual(keys(seen), ["delivery", "lines", "number", "paid", "payment", "ref", "step", "steps", "totals"]);
  assert.deepEqual(seen.step, { name: { en: "New", ru: "Новый", uz: "Yangi" }, kind: "open", position: 0 });
  // The business's steps on the way, in order, for the page to show progress: never the cancelled one, never an id.
  const flow = (await x.snap("orderStages")).orderStages.filter((st) => st.kind !== "cancelled");
  assert.deepEqual(seen.steps, flow.map((st) => ({ name: st.name, kind: st.kind })));
  assert.deepEqual(seen.lines, [{ productId: p.id, variantId: p.variants[0].id, name: "Shampoo", variant: "", qty: 1, price: 40000, total: 40000 }]);
  assert.deepEqual(seen.delivery, { method: { id: "pickup", name: { en: "Pickup", ru: "Самовывоз", uz: "Olib ketish" } }, address: "", date: D(2), window: { from: "12:00", to: "15:00" }, time: "", fee: 0 });
  assert.deepEqual(seen.totals, { subtotal: 40000, discount: 0, fee: 0, total: 40000 });
  assert.equal(seen.number, o.number);
  // The team moves it: the customer sees the business's own step name.
  ok(await x.b.call("POST", `${x.crm}/orders/${o.id}/step`, { to: "packing" }));
  assert.deepEqual(ok(await x.pub("GET", `/orders/${made.ref}?token=${made.token}`)).order.step, { name: { en: "Packing", ru: "Сборка", uz: "Yigʻilmoqda" }, kind: "reserved", position: flow.findIndex((st) => st.id === "packing") });
  ok(await x.b.call("POST", `${x.crm}/orders/${o.id}/cancel`, {}));
  assert.equal(ok(await x.pub("GET", `/orders/${made.ref}?token=${made.token}`)).order.step.position, null, "a cancelled order is on no step of the way");
  assert.equal((await x.pub("GET", `/orders/${made.ref}?token=nope`)).status, 404);

  const refused = async (over, code, status = 422) => {
    const r = await x.pub("POST", "/orders", order(p, { phone: "+998 93 444 55 77", ...over }), browser());
    assert.equal(r.status, status, JSON.stringify(r.body));
    assert.ok(r.body.code === code || codes(r.body.hard).includes(code) || codes(r.body.soft).includes(code), `${code}: ${JSON.stringify(r.body)}`);
  };
  await refused({ delivery: { method: "courier", date: D(2), window: { from: "12:00", to: "15:00" } } }, "address_required");
  await refused({ delivery: { method: "teleport", date: D(2), time: "12:00" } }, "bad_delivery", 400);
  await refused({ payment: "card" }, "bad_payment", 400);
  await refused({ delivery: { method: "pickup", date: D(2), window: { from: "10:00", to: "11:00" } } }, "bad_window");
  await refused({ delivery: { method: "pickup", date: D(40), window: { from: "12:00", to: "15:00" } } }, "too_far");
  await refused({ delivery: { method: "pickup", date: D(-1), window: { from: "12:00", to: "15:00" } } }, "past_day");
  const delivery = (await x.snap("settings")).settings.delivery;
  ok(await x.settings({ settings: { delivery: { ...delivery, closed: [{ date: D(2), note: "Supplier visit" }] } } }));
  const closed = await x.pub("POST", "/orders", order(p, { phone: "+998 93 444 55 77" }), browser());
  assert.deepEqual(closed.body.soft, [{ code: "closed_day", date: D(2) }], "the business's note stays inside");
  ok(await x.settings({ settings: { delivery } }));
  for (const extra of [{ force: true }, { paid: true }, { discount: 1000 }, { lines: [{ productId: p.id, variantId: p.variants[0].id, qty: 1, price: 1 }] }, { source: "phone" }]) {
    assert.equal((await x.pub("POST", "/orders", order(p, extra))).status, 400, JSON.stringify(extra));
  }
  // A courier needs the address; it is kept as typed.
  const courier = ok(await x.pub("POST", "/orders", order(p, { phone: "+998 93 000 00 01", delivery: { method: "courier", address: "Chilonzor 5, kv 12", date: D(2), window: { from: "15:00", to: "18:00" } } }), browser()), 201);
  const cv = ok(await x.pub("GET", `/orders/${courier.ref}?token=${courier.token}`)).order;
  assert.deepEqual([cv.delivery.address, cv.delivery.fee, cv.totals.total], ["Chilonzor 5, kv 12", 30000, 70000]);
});

test("order fields the business needs: listed for the page, required ones bind, the team's own are left out", async () => {
  const x = await business();
  const p = await product(x);
  ok(await x.settings({ fields: { order: [{ id: "recipient", name: "Recipient", type: "text", required: true }, { id: "wrap", name: "Gift wrap", type: "yesno" }, { id: "inside", name: "Packed by", type: "text" }] } }));
  assert.deepEqual(ok(await x.pub("GET", "/")).shop.fields, [{ id: "recipient", name: "Recipient", type: "text" }], "only the ones it needs");
  const r = await x.pub("POST", "/orders", order(p));
  assert.deepEqual([r.status, codes(r.body.hard)], [422, ["field_required"]]);
  assert.equal((await x.pub("POST", "/orders", order(p, { fields: { recipient: 5 } }))).body.code, "bad_fields");
  ok(await x.pub("POST", "/orders", order(p, { fields: { recipient: "Madina opa", wrap: true, inside: "Free of charge" } })), 201);
  const [made] = (await x.snap("orders")).orders;
  assert.deepEqual(made.fields, { recipient: "Madina opa" });
});

test("the last item: of two customers at once, exactly one gets it; accepted orders and ones waiting both count", async () => {
  const x = await business();
  const p = await product(x, { opening: 1 });
  const [r1, r2] = await Promise.all([
    x.pub("POST", "/orders", order(p, { phone: "+998 93 000 00 11" }), browser()),
    x.pub("POST", "/orders", order(p, { phone: "+998 93 000 00 12" }), browser()),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [201, 422], JSON.stringify([r1.body, r2.body]));
  assert.deepEqual((r1.status === 422 ? r1 : r2).body.hard, [{ code: "short", variantId: p.variants[0].id, productId: p.id, left: 0 }]);
  assert.equal((await x.snap("orders")).orders.length, 1);
  const shown = async () => ok(await x.pub("GET", "/products")).products;
  assert.deepEqual((await shown())[0].variants[0], { id: p.variants[0].id, values: {}, price: 40000, available: false, left: 0 });

  // The team accepts it (the goods are held): still nothing for customers. Called off: free again.
  const [o] = (await x.snap("orders")).orders;
  ok(await x.b.call("POST", `${x.crm}/orders/${o.id}/step`, { to: "confirmed" }));
  assert.equal((await x.pub("POST", "/orders", order(p, { phone: "+998 93 000 00 13" }), browser())).status, 422);
  ok(await x.b.call("POST", `${x.crm}/orders/${o.id}/cancel`, {}));
  assert.equal((await shown())[0].variants[0].left, 1);
  ok(await x.pub("POST", "/orders", order(p, { phone: "+998 93 000 00 14" }), browser()), 201);
  // An off-sale product can't be ordered here, nor a variant of another product.
  ok(await x.b.call("PUT", `${x.crm}/products/${p.id}`, { onSale: false }));
  const off = await x.pub("POST", "/orders", order(p, { phone: "+998 93 000 00 15" }), browser());
  assert.deepEqual([off.status, off.body.hard], [422, [{ code: "off_sale", variantId: p.variants[0].id, productId: p.id }]]);
  const q = await product(x);
  const mixed = await x.pub("POST", "/orders", order(p, { phone: "+998 93 000 00 16", lines: [{ productId: q.id, variantId: p.variants[0].id, qty: 1 }] }), browser());
  assert.equal(mixed.body.hard[0].code, "off_sale");
});

test("ordering: every other refusal comes before the stock check, so a refusal never tells how much is left", async () => {
  const x = await business();
  const p = await product(x, { opening: 3 });
  const window = { from: "12:00", to: "15:00" };
  let n = 0;
  const reasons = async (over) => {
    const body = order(p, { phone: `+998 93 100 00 ${String(++n).padStart(2, "0")}`, lines: [{ productId: p.id, variantId: p.variants[0].id, qty: 8 }], ...over });
    const r = await x.pub("POST", "/orders", body, browser());
    assert.equal(r.status, 422, JSON.stringify(r.body));
    return [...codes(r.body.hard), ...codes(r.body.soft)];
  };
  // Eight asked, three on the shelf: each of these answers its own reason, never "short".
  assert.deepEqual(await reasons({ delivery: { method: "pickup", date: D(-1), window } }), ["past_day"]);
  assert.deepEqual(await reasons({ delivery: { method: "courier", date: D(2), window } }), ["address_required"]);
  const delivery = (await x.snap("settings")).settings.delivery;
  ok(await x.settings({ settings: { delivery: { ...delivery, closed: [{ date: D(2), note: "Supplier" }] } } }));
  assert.deepEqual(await reasons({}), ["closed_day"]);
  ok(await x.settings({ settings: { delivery } }));
  ok(await x.settings({ fields: { order: [{ id: "card", name: "Card text", type: "text", required: true }] } }));
  assert.deepEqual(await reasons({}), ["field_required"]);
  ok(await x.settings({ fields: { order: [] } }));
  // Only an order that would really be placed meets the stock check.
  assert.deepEqual(await reasons({}), ["short"]);
  assert.deepEqual((await x.snap("orders")).orders, []);
});

test("a page order holds what it asks for only for a while, and never more of one thing than the page shows", async () => {
  const x = await business();
  const p = await product(x, { opening: LEFT_CAP });
  const line = (qty) => ({ productId: p.id, variantId: p.variants[0].id, qty });
  // One order asks for at most LEFT_CAP of a thing, however its lines are split.
  for (const lines of [[line(LEFT_CAP + 1)], [line(6), line(6)]]) {
    const r = await x.pub("POST", "/orders", order(p, { phone: "+998 93 200 00 01", lines }), browser());
    assert.equal(r.status, 400, JSON.stringify(lines));
  }
  const held = ok(await x.pub("POST", "/orders", order(p, { phone: "+998 93 200 00 02", lines: [line(LEFT_CAP)] }), browser()), 201);
  const left = async () => ok(await x.pub("GET", "/products")).products[0].variants[0];
  assert.deepEqual([(await left()).available, (await left()).left], [false, 0]);
  const late = await x.pub("POST", "/orders", order(p, { phone: "+998 93 200 00 03" }), browser());
  assert.deepEqual([late.status, late.body.hard], [422, [{ code: "short", variantId: p.variants[0].id, productId: p.id, left: 0 }]]);
  // The team hasn't looked at it in half an hour: other customers may have the goods again.
  await query(
    "UPDATE crm_orders SET created_at = now() - interval '31 minutes' WHERE workspace_id = $1 AND id = (SELECT order_id FROM crm_public_requests WHERE workspace_id = $1 AND ref = $2)",
    [x.ws.id, held.ref]
  );
  assert.deepEqual([(await left()).available, (await left()).left], [true, LEFT_CAP]);
  ok(await x.pub("POST", "/orders", order(p, { phone: "+998 93 200 00 03" }), browser()), 201);
  // The held order itself is still there for the team.
  assert.equal((await x.snap("orders")).orders.length, 2);
});

test("pictures: an uploaded one is served to the page while a product on sale shows it", async () => {
  const x = await business();
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
  const form = new FormData();
  form.append("file", new Blob([png], { type: "image/png" }), "a.png");
  const { image } = ok(await x.b.call("POST", `${x.crm}/products/images`, form), 201);
  const p = await product(x, { image });
  const shown = ok(await x.pub("GET", "/products")).products.find((v) => v.id === p.id).image;
  const name = image.split("/").pop();
  assert.equal(shown, `/public/crm/${x.slug}/images/${name}`);
  const got = await x.pub("GET", `/images/${name}`);
  assert.equal(got.status, 200);
  // The one answer here that may be kept, by a CDN too: it is what the page shows anyone, and a
  // picture's name never changes. A week at most in a shared cache (s-maxage).
  assert.equal(got.headers.get("cache-control"), "public, max-age=86400, s-maxage=604800");
  assert.equal(got.headers.get("x-content-type-options"), "nosniff");
  ok(await x.b.call("PUT", `${x.crm}/products/${p.id}`, { onSale: false }));
  assert.equal((await x.pub("GET", `/images/${name}`)).status, 404);
  assert.equal((await x.pub("GET", "/images/..%2F..%2Fetc")).status, 404);
});

test("catalogue: the description as typed and every photo, each served only while the product is on sale", async () => {
  const x = await business();
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
  const upload = async () => {
    const form = new FormData();
    form.append("file", new Blob([png], { type: "image/png" }), "a.png");
    return ok(await x.b.call("POST", `${x.crm}/products/images`, form), 201).image;
  };
  const [a, b] = [await upload(), await upload()];
  const p = await product(x, { images: [a, b], description: "Soft shampoo.\n\nFor every day." });
  const plain = await product(x, { name: "Plain", image: "/products/static.jpg" });
  const list = async () => ok(await x.pub("GET", "/products")).products;
  const seen = (await list()).find((v) => v.id === p.id);
  const name = (path) => path.split("/").pop();
  assert.equal(seen.description, "Soft shampoo.\n\nFor every day.");
  assert.deepEqual(seen.images, [a, b].map((path) => `/public/crm/${x.slug}/images/${name(path)}`));
  assert.equal(seen.image, seen.images[0]);
  assert.deepEqual((await list()).find((v) => v.id === plain.id).images, ["/products/static.jpg"], "a product with its one old picture");
  // The second photo is served like the main one, and stops with it.
  assert.equal((await x.pub("GET", `/images/${name(b)}`)).status, 200);
  ok(await x.b.call("PUT", `${x.crm}/products/${p.id}`, { onSale: false }));
  assert.equal((await x.pub("GET", `/images/${name(b)}`)).status, 404);
  assert.equal((await x.pub("GET", `/images/${name(a)}`)).status, 404);
  ok(await x.b.call("PUT", `${x.crm}/products/${p.id}`, { onSale: true }));
  assert.equal((await x.pub("GET", `/images/${name(b)}`)).status, 200);
  // Taken out of the gallery: no longer served (and removed).
  ok(await x.b.call("PUT", `${x.crm}/products/${p.id}`, { images: [a] }));
  assert.equal((await x.pub("GET", `/images/${name(b)}`)).status, 404);
  assert.deepEqual((await list()).find((v) => v.id === p.id).images.length, 1);
});

test("orders and bookings: an optional Telegram username, saved on a new customer, never on a known one", async () => {
  const x = await business();
  const p = await product(x, { opening: 9 });
  const placed = (over, status = 201) => x.pub("POST", "/orders", order(p, over), browser()).then((r) => ok(r, status));
  const byPhone = async (phone) => (await x.snap("customers")).customers.find((c) => c.phone === phone);
  await placed({ phone: "+998 93 100 00 01", telegram: "@Malika_Flowers" });
  assert.equal((await byPhone("+998931000001")).telegram, "Malika_Flowers", "kept bare, as the team's handles are");
  await placed({ phone: "+998 93 100 00 02", telegram: "https://t.me/aziz_k" });
  assert.equal((await byPhone("+998931000002")).telegram, "aziz_k");
  await placed({ phone: "+998 93 100 00 03", telegram: "" });
  assert.equal((await byPhone("+998931000003")).telegram, "");
  // A known customer keeps what the team stored: a handle typed on a page never reroutes their notices.
  await placed({ phone: "+998 93 100 00 01", telegram: "@someone_else" });
  assert.equal((await byPhone("+998931000001")).telegram, "Malika_Flowers");
  // Not a username: 400 bad_telegram, nothing saved.
  for (const bad of ["@ab", "@1abc_def", "@has space", "@name!", "@" + "a".repeat(33), "https://evil.example/x"]) {
    const r = await x.pub("POST", "/orders", order(p, { phone: "+998 93 100 00 09", telegram: bad }), browser());
    assert.equal(r.status, 400, bad);
    assert.ok(JSON.stringify(r.body).includes("bad_telegram"), bad);
  }
  assert.equal(await byPhone("+998931000009"), undefined);
  assert.equal((await x.pub("POST", "/orders", order(p, { telegram: 5 }), browser())).status, 400);
  // The booking page takes it too.
  ok(await x.pub("POST", "/bookings", visit(x, { phone: "+998 90 100 00 05", telegram: "@dilnoza_b" }), browser()), 201);
  assert.equal((await byPhone("+998901000005")).telegram, "dilnoza_b");
});

test("pictures have their own read limit: a page full of them never uses up the page's", async () => {
  const x = await business();
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
  const form = new FormData();
  form.append("file", new Blob([png], { type: "image/png" }), "a.png");
  const { image } = ok(await x.b.call("POST", `${x.crm}/products/images`, form), 201);
  await product(x, { image });
  const name = image.split("/").pop();
  const v = browser();
  for (let i = 0; i < PICTURES_PER_IP; i++) assert.equal((await x.pub("GET", `/images/${name}`, undefined, v)).status, 200, `picture ${i + 1}`);
  assert.equal((await x.pub("GET", "/", undefined, v)).status, 200, "the page still reads");
  assert.equal((await x.pub("GET", "/products", undefined, v)).status, 200);
  const over = await x.pub("GET", `/images/${name}`, undefined, v);
  assert.deepEqual([over.status, over.body.code], [429, "rate_limited"]);
  assert.equal((await x.pub("GET", `/images/${name}`, undefined, browser())).status, 200, "another visitor is not held back");
});

/* ───── Open now, and the page's own pictures ───── */

test("open now: worked out from the business's hours on its own clock, less the days it is closed", () => {
  const plain = { dayStart: "09:00", dayEnd: "21:00", branch: null, timeOff: [] };
  // 2026-11-18 is a Wednesday.
  assert.deepEqual(openingOf("2026-11-18T10:15", plain), { open: true, until: "21:00", opens: null });
  assert.deepEqual(openingOf("2026-11-18T08:59", plain), { open: false, until: null, opens: { date: "2026-11-18", time: "09:00" } });
  assert.deepEqual(openingOf("2026-11-18T21:00", plain), { open: false, until: null, opens: { date: "2026-11-19", time: "09:00" } });
  // The default branch's own hours win: closed on Sundays, short on Saturdays.
  const hours = { 0: null, 1: ["10:00", "19:00"], 2: ["10:00", "19:00"], 3: ["10:00", "19:00"], 4: ["10:00", "19:00"], 5: ["10:00", "19:00"], 6: ["10:00", "15:00"] };
  const branch = { ...plain, branch: { id: "b1", hours, active: true } };
  assert.deepEqual(openingOf("2026-11-18T09:30", branch).opens, { date: "2026-11-18", time: "10:00" });
  assert.deepEqual(openingOf("2026-11-21T14:00", branch), { open: true, until: "15:00", opens: null });
  assert.deepEqual(openingOf("2026-11-21T16:00", branch).opens, { date: "2026-11-23", time: "10:00" }, "Saturday evening: Monday, past the closed Sunday");
  // A holiday for the whole business, and one for another branch that doesn't count.
  const holiday = { ...plain, timeOff: [{ staffId: null, branchId: null, start: "2026-11-19T00:00", end: "2026-11-19T23:59" }] };
  assert.deepEqual(openingOf("2026-11-18T22:00", holiday).opens, { date: "2026-11-20", time: "09:00" });
  const elsewhere = { ...branch, timeOff: [{ staffId: null, branchId: "b2", start: "2026-11-18T00:00", end: "2026-11-18T23:59" }] };
  assert.equal(openingOf("2026-11-18T12:00", elsewhere).open, true);
  // Closed for a few hours in the middle of the day: open until it starts, and again after.
  const lunch = { ...plain, timeOff: [{ staffId: null, branchId: null, start: "2026-11-18T13:00", end: "2026-11-18T13:59" }] };
  assert.deepEqual(openingOf("2026-11-18T12:00", lunch), { open: true, until: "13:00", opens: null });
  assert.deepEqual(openingOf("2026-11-18T13:30", lunch).opens, { date: "2026-11-18", time: "14:00" });
  // Around the clock: open, with no closing time to say.
  assert.deepEqual(openingOf("2026-11-18T03:00", { ...plain, dayStart: "00:00", dayEnd: "24:00" }), { open: true, until: null, opens: null });
  // A closed default branch, or no working day ahead at all: closed, and nothing to promise.
  assert.deepEqual(openingOf("2026-11-18T12:00", { ...branch, branch: { id: "b1", hours, active: false } }), { open: false, until: null, opens: null });
  assert.deepEqual(openingOf("2026-11-18T12:00", { ...branch, branch: { id: "b1", hours: Object.fromEntries(Object.keys(hours).map((d) => [d, null])), active: true } }).opens, null);
});

test("GET /: open now comes from the server, and a business holiday today closes the page's day", async () => {
  const x = await business();
  const front = ok(await x.pub("GET", "/"));
  const settings = (await x.snap("settings")).settings;
  assert.deepEqual(front.hours, openingOf(front.now, { dayStart: settings.dayStart, dayEnd: settings.dayEnd, branch: null, timeOff: [] }));
  // Open around the clock, then a holiday today and tomorrow for the whole business.
  ok(await x.settings({ settings: { dayStart: "00:00", dayEnd: "24:00" } }));
  assert.deepEqual(ok(await x.pub("GET", "/")).hours, { open: true, until: null, opens: null });
  await x.post("/time-off", { start: `${D(0)}T00:00`, end: `${D(1)}T23:59`, note: "Holiday" });
  assert.deepEqual(ok(await x.pub("GET", "/")).hours, { open: false, until: null, opens: { date: D(2), time: "00:00" } });
  // The holiday's note is the business's own: it never reaches the page.
  assert.ok(!JSON.stringify(ok(await x.pub("GET", "/"))).includes("Holiday"));
});

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const JPG = Buffer.from("ffd8ffe000104a46494600010100000100010000", "hex");
const fileForm = (buffer, type = "image/png", name = "a.png") => {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type }), name);
  return form;
};

test("page pictures: admins upload a cover and a logo; the page shows them while it is on, and only the current ones", async () => {
  const x = await business();
  const upload = (kind, form, b = x.b) => b.call("POST", `${x.crm}/public/images/${kind}`, form);
  const cover = ok(await upload("cover", fileForm(PNG)), 201);
  assert.deepEqual(keys(cover), ["changes", "pageImages", "rev"]);
  assert.match(cover.pageImages.cover, /^cover-[0-9a-f-]{36}\.png$/);
  assert.equal(cover.changes.top.settings.pageImages.cover, cover.pageImages.cover, "the settings as the app keeps them");
  const logo = ok(await upload("logo", fileForm(JPG, "image/jpeg", "l.jpg")), 201);
  assert.match(logo.pageImages.logo, /^logo-[0-9a-f-]{36}\.jpg$/);
  assert.equal(logo.pageImages.cover, cover.pageImages.cover);
  assert.deepEqual((await x.snap("settings")).settings.pageImages, logo.pageImages);

  // The page: their addresses on the page's own API, served with the product pictures' headers.
  const front = ok(await x.pub("GET", "/"));
  assert.equal(front.cover, `/public/crm/${x.slug}/page-images/${cover.pageImages.cover}`);
  assert.equal(front.logo, `/public/crm/${x.slug}/page-images/${logo.pageImages.logo}`);
  assert.ok(!front.cover.includes(x.ws.id), "no workspace id in the address");
  const got = await x.pub("GET", `/page-images/${cover.pageImages.cover}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "image/png");
  assert.equal(got.headers.get("x-content-type-options"), "nosniff");
  assert.match(got.headers.get("cache-control"), /^public, /);
  assert.equal((await x.pub("GET", `/page-images/${logo.pageImages.logo}`)).headers.get("content-type"), "image/jpeg");

  // Saving the tab's text fields keeps them; PUT /settings can't set them.
  ok(await x.settings({ settings: { publicPage: { ...PAGE, slug: x.slug, address: "Tashkent, Navoi 2" } } }));
  assert.equal(ok(await x.pub("GET", "/")).cover, front.cover);
  const sneak = await x.settings({ settings: { pageImages: { cover: "", logo: "" } } });
  assert.equal(sneak.status, 400);

  // A new cover replaces the old one: the old address answers the page's 404.
  const next = ok(await upload("cover", fileForm(JPG, "image/jpeg", "c.jpg")), 201);
  assert.notEqual(next.pageImages.cover, cover.pageImages.cover);
  assert.equal((await x.pub("GET", `/page-images/${cover.pageImages.cover}`)).status, 404);
  assert.equal((await x.pub("GET", `/page-images/${next.pageImages.cover}`)).status, 200);

  // Removed: gone from the page and from its API.
  const removed = ok(await x.b.call("DELETE", `${x.crm}/public/images/cover`));
  assert.equal(removed.pageImages.cover, "");
  assert.equal(removed.pageImages.logo, logo.pageImages.logo);
  assert.equal(ok(await x.pub("GET", "/")).cover, "");
  assert.equal((await x.pub("GET", `/page-images/${next.pageImages.cover}`)).status, 404);
  // A product picture's path, a made-up name, a path outside: the same 404.
  for (const bad of ["x.png", "..%2F..%2Fetc", `cover-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}.png`]) assert.equal((await x.pub("GET", `/page-images/${bad}`)).status, 404, bad);

  // Both pages off: the picture is no longer shown, with the same 404 as an unknown address.
  ok(await x.settings({ settings: { publicPage: { ...PAGE, slug: x.slug, booking: false, shop: false } } }));
  assert.deepEqual((await x.pub("GET", `/page-images/${logo.pageImages.logo}`)).body, { message: "Not found", code: "not_found" });
  // The settings tab still shows it to the workspace's people for its preview; nobody else.
  const preview = await x.b.call("GET", `${x.crm}/public/images/${logo.pageImages.logo}`);
  assert.deepEqual([preview.status, preview.headers.get("content-type")], [200, "image/jpeg"]);
  assert.equal((await browser().call("GET", `${x.crm}/public/images/${logo.pageImages.logo}`)).status, 401);
  assert.equal((await x.b.call("GET", `${x.crm}/public/images/${next.pageImages.cover}`)).status, 404, "a removed one is gone for the tab too");
});

test("page pictures: only admins, only pictures, up to 5 MB, and only a cover or a logo", async () => {
  const x = await business();
  const agent = await teammate(x, "agent");
  const upload = (kind, form, b = x.b) => b.call("POST", `${x.crm}/public/images/${kind}`, form);
  assert.equal((await upload("cover", fileForm(PNG), agent.b)).status, 403);
  assert.equal((await agent.b.call("DELETE", `${x.crm}/public/images/cover`)).status, 403);
  const text = await upload("cover", fileForm(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), "image/svg+xml", "a.svg"));
  assert.deepEqual([text.status, text.body.code], [415, "bad_image"]);
  const none = await x.b.call("POST", `${x.crm}/public/images/cover`, new FormData());
  assert.deepEqual([none.status, none.body.code], [400, "bad_image"]);
  const big = await upload("logo", fileForm(Buffer.concat([JPG, Buffer.alloc(5 * 1024 * 1024)]), "image/jpeg", "big.jpg"));
  assert.deepEqual([big.status, big.body.code], [413, "image_too_large"]);
  assert.equal((await upload("banner", fileForm(PNG))).status, 404);
  assert.deepEqual((await x.snap("settings")).settings.pageImages ?? { cover: "", logo: "" }, { cover: "", logo: "" }, "nothing was kept");
});

/* ───── Tenancy, transport, limits ───── */

test("tenancy: one address never reaches another workspace's rows", async () => {
  const a = await business();
  const b = await business();
  const pb = await product(b);
  const bookedB = ok(await b.pub("POST", "/bookings", visit(b)), 201);
  const orderedB = ok(await b.pub("POST", "/orders", order(pb)), 201);
  assert.equal((await a.pub("GET", `/bookings/${bookedB.ref}?token=${bookedB.token}`)).status, 404);
  assert.equal((await a.pub("POST", `/bookings/${bookedB.ref}/cancel`, { token: bookedB.token })).status, 404);
  assert.equal((await a.pub("GET", `/orders/${orderedB.ref}?token=${orderedB.token}`)).status, 404);
  assert.equal((await a.pub("GET", `/slots?day=${D(1)}&serviceIds=${b.s1}`)).body.code, "bad_service");
  assert.equal((await a.pub("POST", "/bookings", visit(a, { serviceIds: [b.s1] }))).body.code, "bad_service");
  assert.equal((await a.pub("POST", "/bookings", visit(a, { staffId: b.p1 }))).body.code, "bad_staff");
  const cross = await a.pub("POST", "/orders", order(pb));
  assert.deepEqual([cross.status, codes(cross.body.hard)], [422, ["off_sale"]]);
  assert.equal((await a.pub("GET", `/images/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}.png`)).status, 404);
  const sa = await a.snap("appointments,orders,customers");
  assert.deepEqual([sa.appointments.length, sa.orders.length, sa.customers.length], [0, 0, 0]);
  // The same phone in two workspaces is two customers.
  ok(await a.pub("POST", "/bookings", visit(a)), 201);
  assert.notEqual((await a.snap("customers")).customers[0].id, (await b.snap("customers")).customers[0].id);
});

test("transport: no cookies, any site may read, only the app's own addresses may write, JSON only", async () => {
  const x = await business();
  const v = browser();
  const read = await v.call("GET", `/public/crm/${x.slug}/`, undefined, { Origin: "https://somebody.example" });
  assert.equal(read.headers.get("access-control-allow-origin"), "https://somebody.example");
  assert.equal(read.headers.get("access-control-allow-credentials"), null);
  assert.equal(read.headers.get("set-cookie"), null);
  assert.equal(read.headers.get("cache-control"), "no-store");
  const pre = await v.call("OPTIONS", `/public/crm/${x.slug}/bookings`, undefined, { Origin: "https://somebody.example", "Access-Control-Request-Method": "POST" });
  assert.equal(pre.headers.get("access-control-allow-origin"), null, "a foreign site can't post");
  const own = await v.call("OPTIONS", `/public/crm/${x.slug}/bookings`, undefined, { Origin: "http://localhost:5192", "Access-Control-Request-Method": "POST" });
  assert.equal(own.headers.get("access-control-allow-origin"), "http://localhost:5192");
  const form = await fetch(`${base}/public/crm/${x.slug}/bookings`, { method: "POST", headers: { "Content-Type": "text/plain", "CF-Connecting-IP": "198.51.100.40" }, body: JSON.stringify(visit(x)) });
  assert.deepEqual([form.status, (await form.json()).code], [415, "send_json"]);
  // A session cookie means nothing here: the owner's own browser books like anyone.
  const asOwner = await x.b.call("POST", `/public/crm/${x.slug}/bookings`, visit(x, { force: true }));
  assert.equal(asOwner.status, 400);
});

test("rate limits: per address of the caller and per page", async () => {
  const x = await business();
  const v = browser();
  for (let i = 0; i < 10; i++) assert.equal((await x.pub("POST", "/bookings", {}, v)).status, 400);
  const over = await x.pub("POST", "/bookings", visit(x), v);
  assert.equal(over.status, 429);
  assert.ok(Number(over.headers.get("retry-after")) > 0);
  assert.equal((await x.pub("GET", "/", undefined, v)).status, 200, "reading has its own limit");
  // Many addresses on one page: the page's own limit (100 writes in 10 minutes; 10 used above).
  const y = await business();
  let last;
  for (let i = 0; i < 100; i++) last = await y.pub("POST", "/bookings", {}, browser());
  assert.equal(last.status, 400);
  assert.equal((await y.pub("POST", "/bookings", visit(y), browser())).status, 429);
  assert.equal((await x.pub("POST", "/bookings", visit(x, { start: `${D(1)}T16:00` }), browser())).status, 201, "another page is not held back");
});
