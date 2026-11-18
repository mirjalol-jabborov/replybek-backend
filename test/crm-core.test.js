// The CRM's foundation: packages, the snapshot, settings with their guards, customers, tenancy
// and live updates. Booking and Store have their own files.
import assert from "node:assert/strict";
import { test } from "node:test";
import { owner, crmOwner, teammate, browser, base } from "./helpers/setup.js";
import { modules } from "../src/crm/modules.js";
import { read } from "../src/crm/db.js";
import { findCustomer, findCustomers } from "../src/crm/core/customers.js";
import { telegramHandle } from "../src/crm/shared/customer.js";
import { nowIn, isZoneName } from "../src/crm/shared/time.js";

/** Opens an event stream like a browser does and collects what arrives. */
async function openStream(path, cookie) {
  const ctl = new AbortController();
  const res = await fetch(base + path, { headers: { "CF-Connecting-IP": "198.51.100.9", Cookie: cookie }, signal: ctl.signal });
  const events = [];
  if (res.ok) {
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
  }
  return {
    status: res.status,
    events,
    /** Resolves with the first event matching `match`, or null after `ms`. */
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

const snap = async (o, only) => (await o.b.call("GET", `${o.crm}/snapshot${only ? `?only=${only}` : ""}`)).body;
const addCustomer = async (o, body) => o.b.call("POST", `${o.crm}/customers`, body);

test("a workspace has the AI agent, the CRM or both, and each product's routes are closed without it", async () => {
  const agentOnly = await owner();
  assert.deepEqual(agentOnly.ws.products, ["agent"], "signing up the old way gives the AI agent");
  const off = await agentOnly.b.call("GET", `/w/${agentOnly.ws.id}/crm/snapshot`);
  assert.equal(off.status, 404);
  assert.equal(off.body.code, "product_off");
  assert.equal((await agentOnly.b.call("GET", `/w/${agentOnly.ws.id}/agents`)).status, 200);

  const o = await crmOwner();
  const w = `/w/${o.ws.id}`;
  assert.deepEqual(o.ws.products, ["crm"]);
  assert.deepEqual((await o.b.call("GET", "/auth/me")).body.workspaces[0].products, ["crm"]);
  for (const [method, path, body] of [
    ["GET", "/agents"],
    ["POST", "/agents", { name: "Support" }],
    ["POST", "/agents/00000000-0000-4000-8000-000000000000/test", { question: "Hi" }],
    ["GET", "/sources"],
    ["GET", "/unanswered"],
    ["GET", "/conversations"],
    ["GET", "/integrations"],
    ["GET", "/analytics"],
    ["POST", "/onboarding/analyze", { url: "https://example.com" }],
  ]) {
    const r = await o.b.call(method, w + path, body);
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.equal(r.body.code, "product_off", `${method} ${path}`);
  }
  // Express matches paths whatever their letter case, so the guard must too.
  for (const [method, path, body] of [["GET", "/AGENTS"], ["GET", "/Conversations"], ["POST", "/Agents", { name: "Support" }], ["GET", "/INTEGRATIONS/setup"]]) {
    const r = await o.b.call(method, w + path, body);
    assert.deepEqual([r.status, r.body.code], [404, "product_off"], `${method} ${path}`);
  }
  // What every workspace has stays open.
  const summary = await o.b.call("GET", w);
  assert.equal(summary.status, 200);
  assert.deepEqual(summary.body.products, ["crm"]);
  for (const path of ["/members", "/invites", "/activity", "/crm/snapshot"]) assert.equal((await o.b.call("GET", w + path)).status, 200, path);
  const s = await openStream(`${w}/stream`, o.b.cookie);
  assert.equal(s.status, 200);
  s.close();

  // Only the owner adds a product; adding it twice changes nothing.
  const admin = await teammate(o, "admin");
  assert.equal((await admin.b.call("POST", `${w}/products`, { add: "agent" })).status, 403);
  assert.equal((await o.b.call("POST", `${w}/products`, { add: "inbox" })).status, 400);
  assert.deepEqual((await o.b.call("POST", `${w}/products`, { add: "agent" })).body, { products: ["crm", "agent"] });
  assert.deepEqual((await o.b.call("POST", `${w}/products`, { add: "agent" })).body, { products: ["crm", "agent"] });
  assert.equal((await o.b.call("GET", `${w}/agents`)).status, 200);

  assert.deepEqual((await agentOnly.b.call("POST", `/w/${agentOnly.ws.id}/products`, { add: "crm" })).body, { products: ["agent", "crm"] });
  assert.equal((await agentOnly.b.call("GET", `/w/${agentOnly.ws.id}/crm/snapshot`)).status, 200);

  assert.equal((await browser().call("POST", "/auth/register", { name: "A", email: "x@test.replybek.dev", password: "correct horse battery", workspace_name: "W", product: "shop" })).status, 400);
});

test("the first snapshot of a new workspace has the default lists and nothing else", async () => {
  const o = await crmOwner("Kamola Yusupova", "Guldasta");
  const db = await snap(o);
  assert.deepEqual(Object.keys(db).sort(), [
    "appointments", "apptStages", "branches", "customers", "deliveryMethods", "fields", "id", "me", "modules", "movements", "name", "notices", "orderStages", "orders",
    "packages", "paymentMethods", "productCategories", "products", "rev", "role", "series", "serviceCategories", "services", "settings", "sources", "staff",
    "tags", "timeOff", "units",
  ]);
  assert.equal(db.id, o.ws.id);
  assert.equal(db.name, "Guldasta");
  assert.equal(db.role, "owner");
  assert.deepEqual(db.me, { id: o.user.id, name: "Kamola Yusupova", staffId: null });
  assert.deepEqual(db.packages, ["crm"]);
  assert.deepEqual(db.modules, { booking: false, store: false });
  for (const key of ["customers", "staff", "services", "timeOff", "appointments", "series", "products", "movements", "orders", "serviceCategories", "productCategories"]) assert.deepEqual(db[key], [], key);
  assert.deepEqual(db.sources.map((s) => s.id), ["telegram", "instagram", "phone", "website", "walkin"]);
  assert.deepEqual(db.sources[2], { id: "phone", name: { en: "Phone call", ru: "Звонок", uz: "Qoʻngʻiroq" }, icon: "phone" });
  assert.deepEqual(db.tags, [{ id: "vip", name: "VIP", tone: "amber" }]);
  assert.deepEqual(db.fields, { customer: [], appointment: [], order: [] });
  assert.deepEqual(db.apptStages.map((s) => s.kind), ["pending", "booked", "here", "here", "done", "noshow", "cancelled"]);
  assert.deepEqual(db.orderStages.map((s) => s.kind), ["open", "reserved", "reserved", "reserved", "done", "cancelled"]);
  assert.deepEqual(db.deliveryMethods.map((m) => [m.id, m.address, m.fee]), [["courier", true, 30000], ["pickup", false, 0]]);
  assert.deepEqual(db.paymentMethods.map((m) => m.id), ["cash", "click", "payme", "card"]);
  assert.deepEqual(db.units.map((u) => u.id), ["pcs", "box", "kg", "l"]);
  assert.equal(db.settings.dayStart, "09:00");
  assert.deepEqual(db.settings.rules, { minNotice: 60, maxDays: 30, cancelUntil: 120, buffer: 0, step: 15, override: true });
  assert.equal(db.settings.delivery.windows.length, 4);
  assert.equal(db.settings.aiConnected, false);
  assert.equal(db.branches.length, 1, "one default branch from the start");
  assert.equal(db.branches[0].default, true);
  // Reading twice makes nothing twice.
  const again = await snap(o);
  assert.equal(again.rev, db.rev);
  assert.deepEqual(again.branches, db.branches);
});

test("the business's clock: the snapshot names its time zone, an admin changes it, and every now follows it", async () => {
  const o = await crmOwner();
  assert.equal((await snap(o, "settings")).settings.timezone, "Asia/Tashkent");
  const put = (b, settings) => b.call("PUT", `${o.crm}/settings`, { settings });
  // Only real zones, written as the zone database writes them: every other name or value is the one code,
  // and the app's own check (isZoneName) refuses the same names.
  for (const timezone of ["Mars/Olympus", "", "asia/tashkent", "Asia/TASHKENT", "Asia/tashkent", "Asia/kolkata", "Etc/GMT+5", "GMT+5", 5, null]) {
    const r = await put(o.b, { timezone });
    assert.equal(r.status, 400, String(timezone));
    assert.equal(r.body.code, "bad_timezone", String(timezone));
    assert.equal(isZoneName(timezone), false, String(timezone));
  }
  // An old name and its new one are both the zone database's (ICU knows Asia/Kolkata as Asia/Calcutta).
  for (const timezone of ["Asia/Kolkata", "Asia/Calcutta", "America/Argentina/Salta", "UTC"]) assert.equal(isZoneName(timezone), true, timezone);
  assert.equal((await put(o.b, { timezone: "Asia/Kolkata" })).status, 200);
  const mate = await teammate(o, "agent");
  assert.equal((await put(mate.b, { timezone: "Europe/Moscow" })).status, 403);
  // Two zones 25 hours apart: the business's day is never the same in both.
  const saved = await put(o.b, { timezone: "Pacific/Kiritimati", slot: 20 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.changes.top.settings.timezone, saved.body.changes.top.settings.slot], ["Pacific/Kiritimati", 20]);
  const near = (tz) => nowIn(tz, new Date());
  const there = (await addCustomer(o, { name: "Aziz Karimov" })).body.changes.set.customers[0].createdAt;
  assert.ok(Math.abs(Date.parse(`${there}:00Z`) - Date.parse(`${near("Pacific/Kiritimati")}:00Z`)) <= 60000, there);
  await put(o.b, { timezone: "Pacific/Pago_Pago" });
  const here = (await addCustomer(o, { name: "Bobur Aliyev" })).body.changes.set.customers[0].createdAt;
  assert.ok(Math.abs(Date.parse(`${here}:00Z`) - Date.parse(`${near("Pacific/Pago_Pago")}:00Z`)) <= 60000, here);
  assert.notEqual(here.slice(0, 10), there.slice(0, 10));
  // Kept as the workspace's clock, not inside the saved settings; the snapshot reads it from there.
  const db = await snap(o, "settings");
  assert.deepEqual([db.settings.timezone, db.settings.slot], ["Pacific/Pago_Pago", 20]);
  const stored = await read(o.ws.id, async (q, cfg) => [cfg.timezone, "timezone" in cfg.data.settings]);
  assert.deepEqual(stored, ["Pacific/Pago_Pago", false]);
});

test("snapshot ?only= gives just those keys, with rev", async () => {
  const o = await crmOwner();
  await addCustomer(o, { name: "Aziz Karimov", phone: "90 123 45 67" });
  const part = await snap(o, "customers,tags");
  assert.deepEqual(Object.keys(part).sort(), ["customers", "rev", "tags"]);
  assert.equal(part.customers.length, 1);
  assert.deepEqual(Object.keys(await snap(o, "orders, products")).sort(), ["orders", "products", "rev"]);
  // The editable lists are saved and announced together, as "settings".
  const lists = await snap(o, "settings");
  assert.deepEqual(Object.keys(lists).sort(), ["apptStages", "deliveryMethods", "fields", "modules", "orderStages", "paymentMethods", "productCategories", "rev", "serviceCategories", "settings", "sources", "tags", "units"]);
  const bad = await o.b.call("GET", `${o.crm}/snapshot?only=customers,secrets`);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "bad_key");
});

test("settings save the keys that were sent, merge settings and fields one level down, and refuse bad shapes", async () => {
  const o = await crmOwner();
  const put = (body) => o.b.call("PUT", `${o.crm}/settings`, body);
  const before = await snap(o);

  const r = await put({ modules: { booking: true, store: false }, settings: { slot: 15, rules: { ...before.settings.rules, minNotice: 120 } }, fields: { customer: [{ id: "dob", name: "Birthday", type: "date" }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body.changes.top).sort(), ["fields", "modules", "settings"]);
  assert.equal(r.body.rev, before.rev + 1);
  const after = await snap(o);
  assert.equal(after.rev, r.body.rev);
  assert.deepEqual(after.modules, { booking: true, store: false });
  assert.equal(after.settings.slot, 15);
  assert.equal(after.settings.rules.minNotice, 120);
  assert.equal(after.settings.dayEnd, "21:00", "settings not sent stay");
  assert.deepEqual(after.settings.delivery, before.settings.delivery);
  assert.deepEqual(after.fields, { customer: [{ id: "dob", name: "Birthday", type: "date" }], appointment: [], order: [] });
  assert.deepEqual(after.sources, before.sources, "lists not sent stay");
  assert.deepEqual(r.body.changes.top.settings, after.settings);

  // A choice keeps its options, anything else drops them; delivery windows come back in order.
  const shaped = await put({
    fields: { order: [{ id: "size", name: "Size", type: "choice", options: ["S", "M", "S"] }, { id: "gift", name: "Gift", type: "yesno", options: ["x"], card: true }] },
    settings: { delivery: { ...before.settings.delivery, windows: [{ from: "15:00", to: "18:00" }, { from: "09:00", to: "12:00" }] } },
  });
  assert.equal(shaped.status, 200, JSON.stringify(shaped.body));
  assert.deepEqual(shaped.body.changes.top.fields.order, [{ id: "size", name: "Size", type: "choice", options: ["S", "M"] }, { id: "gift", name: "Gift", type: "yesno", card: true }]);
  assert.deepEqual(shaped.body.changes.top.settings.delivery.windows.map((w) => w.from), ["09:00", "15:00"]);

  for (const [why, body] of [
    ["nothing to change", {}],
    ["an unknown key", { colours: [] }],
    ["an unknown setting", { settings: { theme: "dark" } }],
    ["a bad time", { settings: { dayStart: "9:00" } }],
    ["half the booking rules", { settings: { rules: { minNotice: 30 } } }],
    ["a window that ends before it starts", { settings: { delivery: { ...before.settings.delivery, windows: [{ from: "15:00", to: "12:00" }] } } }],
    ["no sources at all", { sources: [] }],
    ["two items with one id", { tags: [{ id: "a", name: "A", tone: "" }, { id: "a", name: "B", tone: "" }] }],
    ["a source that takes the AI agent's id", { sources: [...before.sources, { id: "ai", name: "Robot", icon: "bot" }] }],
    ["an empty name", { tags: [{ id: "a", name: "  ", tone: "" }] }],
    ["an unknown colour", { tags: [{ id: "a", name: "A", tone: "pink" }] }],
    ["an unknown field type", { fields: { customer: [{ id: "a", name: "A", type: "photo" }] } }],
    ["an unknown kind of step", { orderStages: before.orderStages.map((s) => (s.id === "packing" ? { ...s, kind: "boxed" } : s)) }],
    ["a fee with a fraction", { deliveryMethods: [{ ...before.deliveryMethods[0], fee: 10.5 }] }],
    ["modules that aren't switches", { modules: { booking: "yes", store: false } }],
  ]) {
    const bad = await put(body);
    assert.equal(bad.status, 400, `${why}: ${JSON.stringify(bad.body)}`);
  }
  const hours = await put({ settings: { dayStart: "22:00" } });
  assert.equal(hours.status, 400);
  assert.equal(hours.body.code, "day_hours");
  assert.equal((await snap(o)).rev, shaped.body.rev, "a refused save changes nothing, not even rev");
});

test("the AI agent shows as connected only with the agent product", async () => {
  const o = await crmOwner();
  const on = await o.b.call("PUT", `${o.crm}/settings`, { settings: { aiConnected: true } });
  assert.equal(on.body.changes.top.settings.aiConnected, false, "nothing to connect to");
  await o.b.call("POST", `/w/${o.ws.id}/products`, { add: "agent" });
  assert.equal((await snap(o)).settings.aiConnected, false, "adding the product doesn't switch the connection on by itself");
  assert.equal((await o.b.call("PUT", `${o.crm}/settings`, { settings: { aiConnected: true } })).body.changes.top.settings.aiConnected, true);
  assert.equal((await snap(o)).settings.aiConnected, true);
});

test("a removed tag leaves every customer, and a source in use can't be removed", async () => {
  const o = await crmOwner();
  const put = (body) => o.b.call("PUT", `${o.crm}/settings`, body);
  const db = await snap(o);
  await put({ tags: [...db.tags, { id: "regular", name: "Regular", tone: "" }] });
  const a = (await addCustomer(o, { name: "Aziz Karimov", phone: "901234567", source: "telegram", tags: ["vip", "regular"] })).body.id;
  const b = (await addCustomer(o, { name: "Dilnoza Aliyeva", phone: "901234568", source: "phone", tags: ["regular"] })).body.id;

  const r = await put({ tags: [{ id: "regular", name: "Regular", tone: "blue" }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.changes.top.tags, [{ id: "regular", name: "Regular", tone: "blue" }]);
  assert.deepEqual(r.body.changes.set.customers.map((c) => [c.id, c.tags]), [[a, ["regular"]]], "only the customer who had the tag comes back");
  assert.deepEqual((await snap(o, "customers")).customers.map((c) => c.tags), [["regular"], ["regular"]]);
  assert.equal(b.length, 36);

  const used = await put({ sources: db.sources.filter((s) => s.id !== "telegram") });
  assert.equal(used.status, 409);
  assert.deepEqual({ code: used.body.code, list: used.body.list, id: used.body.id, count: used.body.count }, { code: "in_use", list: "sources", id: "telegram", count: 1 });
  assert.equal((await snap(o, "sources")).sources.length, 5);
  assert.equal((await put({ sources: db.sources.filter((s) => s.id !== "walkin") })).status, 200, "a source nobody came from can go");
});

test("a board's steps keep their meaning: fixed kinds, minimums, and steps with items in them", async () => {
  const o = await crmOwner();
  const put = (body) => o.b.call("PUT", `${o.crm}/settings`, body);
  const { orderStages, apptStages } = await snap(o);
  const without = (list, id) => list.filter((s) => s.id !== id);
  const code = async (body) => {
    const r = await put(body);
    return [r.status, r.body.code];
  };

  // Rename, recolour, reorder, add and remove empty steps freely.
  const free = [orderStages[0], { id: "stq1", name: "Checked", tone: "green", kind: "reserved", needs: { paid: true } }, orderStages[2], { ...orderStages[1], name: "Accepted" }, ...orderStages.slice(4)];
  assert.equal((await put({ orderStages: free })).status, 200);
  assert.deepEqual((await snap(o, "orderStages")).orderStages, free);

  assert.deepEqual(await code({ orderStages: without(free, "delivered") }), [400, "stage_fixed"], "the one Done step stays");
  assert.deepEqual(await code({ orderStages: [...free, { id: "x2", name: "Also done", tone: "", kind: "done" }] }), [400, "stage_fixed"]);
  assert.deepEqual(await code({ orderStages: free.map((s) => (s.kind === "cancelled" ? { ...s, id: "called_off" } : s)) }), [400, "stage_fixed"], "it can be renamed, not replaced");
  assert.deepEqual(await code({ orderStages: without(free, "new") }), [400, "stage_min"], "new orders need somewhere to land");
  assert.deepEqual(await code({ apptStages: apptStages.filter((s) => s.kind !== "booked") }), [400, "stage_min"]);
  assert.deepEqual(await code({ orderStages: free, moves: { orderStages: [{ from: "packing", to: "confirmed" }] } }), [400, "bad_move"], "only a removed step moves its items");
  assert.equal((await put({ moves: { apptStages: [{ from: "arrived", to: "in_service" }] } })).status, 400, "moves alone change nothing");

  // Steps with items in them. The counts come from the modules; here a stand-in says where the orders are.
  const moved = [];
  const fake = {
    keys: [],
    countUses: async (c, workspaceId, list, ids) => (workspaceId === o.ws.id && list === "orderStages" ? Object.fromEntries(ids.filter((id) => id === "packing").map((id) => [id, 3])) : {}),
    moveStage: async (c, cfg, list, from, to) => {
      moved.push([list, from, to]);
      return { set: { orders: [{ id: "o1", status: to }] } };
    },
  };
  modules.push(fake);
  try {
    assert.deepEqual(await code({ orderStages: free.map((s) => (s.id === "packing" ? { ...s, kind: "open" } : s)) }), [409, "stage_in_use"], "a step with orders can't change what it means");
    const stuck = await put({ orderStages: without(free, "packing") });
    assert.equal(stuck.status, 409);
    assert.deepEqual({ code: stuck.body.code, list: stuck.body.list, id: stuck.body.id, count: stuck.body.count }, { code: "stage_needs_move", list: "orderStages", id: "packing", count: 3 });
    assert.deepEqual(await code({ orderStages: without(free, "packing"), moves: { orderStages: [{ from: "packing", to: "new" }] } }), [400, "bad_move"], "only into a step of the same kind");
    assert.deepEqual(await code({ orderStages: without(free, "packing"), moves: { orderStages: [{ from: "packing", to: "gone" }] } }), [400, "bad_move"]);
    assert.deepEqual(moved, [], "nothing moves while the save is refused");

    const ok = await put({ orderStages: without(free, "packing"), moves: { orderStages: [{ from: "packing", to: "stq1" }] } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(moved, [["orderStages", "packing", "stq1"]]);
    assert.deepEqual(ok.body.changes.set.orders, [{ id: "o1", status: "stq1" }], "the moved items come back with the change");
    assert.deepEqual(ok.body.changes.top.orderStages.map((s) => s.id), ["new", "stq1", "confirmed", "delivered", "cancelled"]);

    // The same guard for the other lists rows point at.
    const units = (await snap(o, "units")).units;
    fake.countUses = async (c, workspaceId, list, ids) => (list === "units" && ids.includes("kg") ? { kg: 2 } : {});
    const unit = await put({ units: without(units, "kg") });
    assert.deepEqual([unit.status, unit.body.code, unit.body.id, unit.body.count], [409, "in_use", "kg", 2]);
    assert.equal((await put({ units: without(units, "box") })).status, 200);
  } finally {
    modules.splice(modules.indexOf(fake), 1);
  }
});

test("customers: add, edit, delete, with the phone kept unique and written one way", async () => {
  const o = await crmOwner();
  await o.b.call("PUT", `${o.crm}/settings`, {
    fields: { customer: [{ id: "dob", name: "Birthday", type: "date" }, { id: "size", name: "Size", type: "choice", options: ["S", "M"] }, { id: "kids", name: "Children", type: "number" }, { id: "news", name: "Newsletter", type: "yesno" }] },
  });

  const made = await addCustomer(o, { name: "  Aziz Karimov ", phone: "+998 (90) 123-45-67", telegram: "@aziz_k", source: "telegram", tags: ["vip"], note: "Prefers mornings", fields: { dob: "1990-05-17", size: "M", kids: 2, news: true } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const [c] = made.body.changes.set.customers;
  assert.equal(made.body.id, c.id);
  assert.match(c.id, /^[0-9a-f-]{36}$/);
  assert.match(c.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "the business's wall clock, to the minute");
  assert.deepEqual({ ...c, id: 0, createdAt: 0 }, { id: 0, name: "Aziz Karimov", phone: "+998901234567", telegram: "aziz_k", instagram: "", source: "telegram", tags: ["vip"], note: "Prefers mornings", fields: { dob: "1990-05-17", size: "M", kids: 2, news: true }, createdAt: 0 });
  assert.equal(made.body.rev, (await snap(o, "rev")).rev);

  const twin = await addCustomer(o, { name: "Someone Else", phone: "90 123 45 67" });
  assert.equal(twin.status, 409);
  assert.deepEqual(twin.body, { message: "Aziz Karimov already has this number.", code: "phone_taken", customerId: c.id, customerName: "Aziz Karimov" });

  for (const [code, body] of [
    ["bad_phone", { name: "A", phone: "12345" }],
    ["bad_source", { name: "A", source: "billboard" }],
    ["bad_tag", { name: "A", tags: ["gold"] }],
    ["bad_fields", { name: "A", fields: { dob: "17.05.1990" } }],
    ["bad_fields", { name: "A", fields: { size: "XL" } }],
    ["bad_fields", { name: "A", fields: { kids: "two" } }],
  ]) {
    const bad = await addCustomer(o, body);
    assert.deepEqual([bad.status, bad.body.code], [400, code], JSON.stringify(body));
  }
  assert.equal((await addCustomer(o, { phone: "901112233" })).status, 400, "a customer needs a name");
  assert.equal((await addCustomer(o, { name: "A", vip: true })).status, 400, "no unknown keys");

  // No phone is fine, and two customers may both have none.
  const quiet = await addCustomer(o, { name: "Malika", instagram: "malika.y", fields: { colour: "red" } });
  assert.equal(quiet.status, 201);
  assert.deepEqual(quiet.body.changes.set.customers[0].fields, {}, "nothing is stored under a field the workspace doesn't have");
  assert.equal((await addCustomer(o, { name: "Sardor" })).status, 201);

  // An edit changes only what it sends.
  const edit = await o.b.call("PUT", `${o.crm}/customers/${c.id}`, { name: "Aziz K.", phone: "+998901234567", fields: { size: "", kids: 3 } });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const [e] = edit.body.changes.set.customers;
  assert.deepEqual([e.name, e.phone, e.telegram, e.note, e.tags, e.fields], ["Aziz K.", "+998901234567", "aziz_k", "Prefers mornings", ["vip"], { dob: "1990-05-17", kids: 3, news: true }]);
  const clash = await o.b.call("PUT", `${o.crm}/customers/${quiet.body.id}`, { phone: "901234567" });
  assert.deepEqual([clash.status, clash.body.code, clash.body.customerId], [409, "phone_taken", c.id]);
  assert.equal((await o.b.call("PUT", `${o.crm}/customers/${c.id}`, {})).status, 400);

  // A field removed from the settings keeps what was typed, and nothing new is written under it.
  await o.b.call("PUT", `${o.crm}/settings`, { fields: { customer: [{ id: "size", name: "Size", type: "choice", options: ["L"] }, { id: "kids", name: "Children", type: "number" }] } });
  await o.b.call("PUT", `${o.crm}/customers/${c.id}`, { fields: { size: "L" } });
  const kept = await o.b.call("PUT", `${o.crm}/customers/${c.id}`, { fields: { dob: "2000-01-01", kids: 4, size: "L" } });
  assert.deepEqual(kept.body.changes.set.customers[0].fields, { dob: "1990-05-17", kids: 4, news: true, size: "L" });

  // A value stored before its field changed (a choice taken off the list, a text field turned into a
  // date) rides along on every later save of the whole form; only a new value has to fit.
  await o.b.call("PUT", `${o.crm}/settings`, { fields: { customer: [{ id: "size", name: "Size", type: "choice", options: ["XL"] }, { id: "kids", name: "Children", type: "text" }] } });
  const older = await o.b.call("PUT", `${o.crm}/customers/${c.id}`, { note: "Moved to evenings", fields: { size: "L", kids: 4 } });
  assert.equal(older.status, 200, JSON.stringify(older.body));
  assert.deepEqual([older.body.changes.set.customers[0].note, older.body.changes.set.customers[0].fields], ["Moved to evenings", { dob: "1990-05-17", kids: 4, news: true, size: "L" }]);
  const fresh = await o.b.call("PUT", `${o.crm}/customers/${c.id}`, { fields: { size: "M", kids: 5 } });
  assert.deepEqual([fresh.status, fresh.body.fields], [400, { size: "bad_value", kids: "bad_value" }]);

  const history = await o.b.call("GET", `${o.crm}/customers/${c.id}/history`);
  assert.equal(history.status, 200);
  assert.equal(history.body.customer.id, c.id);
  assert.deepEqual([history.body.appointments, history.body.orders], [[], []]);

  // A customer with bookings or orders stays. The modules say whether there are any.
  const fake = { keys: [], customerUses: async (conn, workspaceId, id) => (id === c.id ? { orders: 2 } : {}) };
  modules.push(fake);
  try {
    const held = await o.b.call("DELETE", `${o.crm}/customers/${c.id}`);
    assert.deepEqual([held.status, held.body.code, held.body.uses], [409, "customer_in_use", { orders: 2 }]);
  } finally {
    modules.splice(modules.indexOf(fake), 1);
  }
  const gone = await o.b.call("DELETE", `${o.crm}/customers/${c.id}`);
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.body.changes, { del: { customers: [c.id] } });
  assert.equal((await o.b.call("DELETE", `${o.crm}/customers/${c.id}`)).status, 404);
  assert.deepEqual((await snap(o, "customers")).customers.map((x) => x.name), ["Malika", "Sardor"]);
  assert.equal((await addCustomer(o, { name: "New Aziz", phone: "901234567" })).status, 201, "the number is free again");
});

test("a Telegram handle is kept bare however it was typed, and one find answers by id, phone or handle", async () => {
  assert.deepEqual(["@Jasur_K", "t.me/jasur_k", "https://t.me/Jasur_K/", "  telegram.me/jasur_k ", "@@x", "jasur", "Jasur Karimov", ""].map(telegramHandle), ["Jasur_K", "jasur_k", "Jasur_K", "jasur_k", "x", "jasur", "Jasur Karimov", ""]);
  const o = await crmOwner();
  const forms = ["@Jasur_K", "t.me/aziz_k", "https://t.me/Malika_A"];
  const ids = [];
  for (const [i, telegram] of forms.entries()) ids.push((await addCustomer(o, { name: `C${i}`, phone: `+99890000000${i}`, telegram })).body.id);
  assert.deepEqual((await snap(o, "customers")).customers.map((c) => c.telegram), ["Jasur_K", "aziz_k", "Malika_A"]);
  const edited = await o.b.call("PUT", `${o.crm}/customers/${ids[1]}`, { telegram: "https://telegram.me/aziz_k" });
  assert.deepEqual(edited.body.changes.set.customers[0].telegram, "aziz_k");

  const find = (by) => read(o.ws.id, (q, cfg) => findCustomer(q, cfg, by)).then((c) => c?.id || null);
  assert.equal(await find({ id: ids[0] }), ids[0]);
  assert.equal(await find({ id: "nope" }), null);
  assert.equal(await find({ phone: "90 000 00 01" }), ids[1]);
  assert.equal(await find({ phone: "12345" }), null);
  for (const handle of ["jasur_k", "@JASUR_K", "t.me/jasur_k"]) assert.equal(await find({ telegram: handle }), ids[0], handle);
  assert.equal(await find({ telegram: "" }), null);
  // Two customers with one handle: nobody is picked. One from a source left out doesn't count.
  const twin = (await addCustomer(o, { name: "Twin", telegram: "jasur_k", source: "phone" })).body.id;
  assert.equal(await find({ telegram: "jasur_k" }), null);
  assert.equal(await find({ telegram: "jasur_k", notFrom: "phone" }), ids[0]);
  assert.ok(twin);
  // Another workspace's customer is never found.
  const other = await crmOwner();
  assert.equal(await read(other.ws.id, (q, cfg) => findCustomer(q, cfg, { phone: "+998900000001" })), null);
  // Several by id in one read, as findCustomer gives each: only this workspace's.
  const many = await read(o.ws.id, (q, cfg) => findCustomers(q, cfg, [ids[2], ids[0], "00000000-0000-0000-0000-000000000000"]));
  assert.deepEqual(many.map((c) => c.id).sort(), [ids[0], ids[2]].sort());
  assert.deepEqual(many.find((c) => c.id === ids[0]), await read(o.ws.id, (q, cfg) => findCustomer(q, cfg, { id: ids[0] })));
  assert.deepEqual(await read(other.ws.id, (q, cfg) => findCustomers(q, cfg, ids)), []);
  assert.deepEqual(await read(o.ws.id, (q, cfg) => findCustomers(q, cfg, [])), []);
});

test("a team member works with customers; settings and deleting are for admins", async () => {
  const o = await crmOwner();
  const mate = await teammate(o, "agent");
  const admin = await teammate(o, "admin", "Nodira Saidova");
  const db = (await mate.b.call("GET", `${o.crm}/snapshot`)).body;
  assert.equal(db.role, "agent");
  assert.deepEqual(db.me, { id: mate.user.id, name: "Sherzod Karimov", staffId: null });

  const made = await mate.b.call("POST", `${o.crm}/customers`, { name: "Jasur Rahimov", phone: "931234567" });
  assert.equal(made.status, 201);
  assert.equal((await mate.b.call("PUT", `${o.crm}/customers/${made.body.id}`, { note: "Called back" })).status, 200);
  assert.equal((await mate.b.call("GET", `${o.crm}/customers/${made.body.id}/history`)).status, 200);
  assert.equal((await mate.b.call("DELETE", `${o.crm}/customers/${made.body.id}`)).status, 403);
  assert.equal((await mate.b.call("PUT", `${o.crm}/settings`, { modules: { booking: true, store: true } })).status, 403);
  assert.deepEqual((await snap(o, "modules")).modules, { booking: false, store: false });

  assert.equal((await admin.b.call("PUT", `${o.crm}/settings`, { modules: { booking: true, store: true } })).status, 200);
  assert.equal((await admin.b.call("DELETE", `${o.crm}/customers/${made.body.id}`)).status, 200);
});

test("one workspace sees and changes nothing of another", async () => {
  const mine = await crmOwner("Kamola Yusupova", "Guldasta");
  const theirs = await crmOwner("Rustam Aliyev", "Shifo Med");
  const id = (await addCustomer(mine, { name: "Aziz Karimov", phone: "901234567", tags: ["vip"] })).body.id;
  await mine.b.call("PUT", `${mine.crm}/settings`, { tags: [{ id: "vip", name: "VIP", tone: "amber" }, { id: "mine", name: "Only mine", tone: "" }] });

  // Their own paths never show my rows, and my ids read as "not found" there.
  assert.deepEqual((await snap(theirs)).customers, []);
  assert.deepEqual((await snap(theirs)).tags.map((t) => t.id), ["vip"]);
  for (const [method, path, body] of [
    ["PUT", `/customers/${id}`, { name: "Taken" }],
    ["DELETE", `/customers/${id}`],
    ["GET", `/customers/${id}/history`],
  ]) {
    const r = await theirs.b.call(method, theirs.crm + path, body);
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.equal(r.body.message, "Customer not found");
    assert.equal(JSON.stringify(r.body).includes("Aziz"), false);
  }
  // The same number in two businesses is two different customers.
  assert.equal((await addCustomer(theirs, { name: "Aziz K.", phone: "901234567" })).status, 201);
  // Removing their own "vip" tag doesn't touch my customer.
  const r = await theirs.b.call("PUT", `${theirs.crm}/settings`, { tags: [] });
  assert.equal(r.body.changes.set, undefined);

  // My paths are closed to them: the workspace itself reads as "not found".
  for (const [method, path, body] of [
    ["GET", "/snapshot"],
    ["GET", "/stream"],
    ["PUT", "/settings", { tags: [] }],
    ["POST", "/customers", { name: "Planted" }],
    ["PUT", `/customers/${id}`, { name: "Taken" }],
    ["DELETE", `/customers/${id}`],
    ["GET", `/customers/${id}/history`],
  ]) {
    const x = await theirs.b.call(method, mine.crm + path, body);
    assert.equal(x.status, 404, `${method} ${path}`);
    assert.equal(x.body.message, "Workspace not found");
  }
  assert.equal((await theirs.b.call("POST", `/w/${mine.ws.id}/products`, { add: "agent" })).status, 404);

  const db = await snap(mine);
  assert.deepEqual(db.customers.map((c) => [c.id, c.name, c.tags]), [[id, "Aziz Karimov", ["vip"]]]);
  assert.deepEqual(db.tags.map((t) => t.id), ["vip", "mine"]);
  assert.deepEqual(db.packages, ["crm"]);
});

test("open screens hear about a change the moment it is saved", async () => {
  const o = await crmOwner();
  const other = await crmOwner("Rustam Aliyev", "Shifo Med");
  // The first use makes the workspace's CRM rows (and says so); these screens open after that.
  await snap(o);
  await snap(other);
  const s = await openStream(`/w/${o.ws.id}/stream`, o.b.cookie);
  const own = await openStream(`${o.crm}/stream`, o.b.cookie);
  const far = await openStream(`${other.crm}/stream`, other.b.cookie);
  try {
    assert.equal(s.status, 200);
    assert.ok(await s.next((e) => e.event === "ready"));
    assert.ok(await own.next((e) => e.event === "ready"));
    assert.ok(await far.next((e) => e.event === "ready"));

    const id = (await addCustomer(o, { name: "Aziz Karimov", phone: "901234567", tags: ["vip"] })).body.id;
    const heard = await s.next((e) => e.event === "crm");
    assert.deepEqual(heard?.data, { k: ["customers"] }, "the workspace's stream says which part of the snapshot changed");
    assert.deepEqual((await own.next((e) => e.event === "crm"))?.data, { k: ["customers"] }, "and so does the CRM's own stream");
    assert.equal(s.events.some((e) => e.event === "message"), false, "the inbox's screens hear nothing");

    // An edit that changes nothing stays quiet; settings are announced as one key, with the rows that changed with them.
    s.events.length = 0;
    await o.b.call("PUT", `${o.crm}/customers/${id}`, { name: "Aziz Karimov" });
    await o.b.call("PUT", `${o.crm}/settings`, { tags: [] });
    const both = await s.next((e) => e.event === "crm" && e.data.k.includes("settings"));
    assert.deepEqual([...(both?.data.k || [])].sort(), ["customers", "settings"]);
    assert.equal(s.events.filter((e) => e.event === "crm").length, 1, "the quiet edit sent nothing, and one save is one event");

    await new Promise((r) => setTimeout(r, 300));
    assert.equal(far.events.some((e) => e.event === "crm"), false, "another workspace hears nothing");
  } finally {
    s.close();
    own.close();
    far.close();
  }
});
