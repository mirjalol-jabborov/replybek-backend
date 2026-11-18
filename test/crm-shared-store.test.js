// The Store module's pure rules (src/crm/shared/store.js): no database, no server, no clock.
import test from "node:test";
import assert from "node:assert/strict";
import {
  K, totals, isPaid, orderTotal, lineTotal, available, stockState, kindIn, flowOf, nextStage, needsFor, missingFor, requiredMissing,
  planMove, planLines, planWriteOff, planCount, shortages, canEditLines,
  checkDelivery, deliveryAllowed, dayProblem, windowsFor, earliestToday, suggestDelivery, windowText, rulesOf,
} from "../src/crm/shared/store.js";

const STAGES = [
  { id: "new", name: "New", kind: "open" },
  { id: "wait", name: "Waiting", kind: "open" },
  { id: "ok", name: "Accepted", kind: "reserved" },
  { id: "pack", name: "Packing", kind: "reserved" },
  { id: "done", name: "Delivered", kind: "done" },
  { id: "off", name: "Cancelled", kind: "cancelled" },
];
const FIELDS = [
  { id: "recipient", name: "Recipient", type: "text" },
  { id: "call", name: "Call first", type: "yesno" },
  { id: "must", name: "Must", type: "text", required: true },
];
const stock = () => ({ a: { stock: 5, reserved: 1, productId: "pa", name: "Roses" }, b: { stock: 2, reserved: 0, productId: "pb", name: "Card" } });
const order = (status, over = {}) => ({ id: "o1", status, lines: [{ variantId: "a", qty: 2, price: 1000 }, { variantId: "b", qty: 1, price: 500 }, { variantId: "a", qty: 1, price: 900 }], fields: {}, payments: [], ...over });
const move = (o, to, opts, over = {}) => planMove({ stages: STAGES, fields: FIELDS, order: o, stock: stock(), ...over }, to, opts);
const byVariant = (rows) => Object.fromEntries(rows.map((r) => [r.variantId, r]));

test("money: lines, both discounts, the fee, payments and the balance", () => {
  const o = { lines: [{ qty: 2, price: 100000, discount: 20000 }, { qty: 1, price: 50000 }], discount: 30000, delivery: { fee: 25000 }, payments: [{ amount: 100000 }, { amount: 150000 }, { amount: -50000 }] };
  assert.deepEqual(totals(o), { lines: 250000, lineDiscounts: 20000, subtotal: 230000, discount: 30000, fee: 25000, total: 225000, paid: 200000, refunded: 50000, balance: 25000 });
  assert.equal(lineTotal(o.lines[0]), 180000);
  assert.equal(orderTotal(o), 225000);
  assert.equal(isPaid(o), false);
  assert.equal(isPaid({ ...o, payments: [{ amount: 225000 }] }), true);
  // Overpaid after the order got cheaper: the balance goes below zero, it still counts as paid.
  assert.equal(totals({ ...o, payments: [{ amount: 300000 }] }).balance, -75000);
  // An order discount is never more than there is to take off; the fee is still owed.
  assert.deepEqual(totals({ lines: [{ qty: 1, price: 1000 }], discount: 5000, delivery: { fee: 300 } }), { lines: 1000, lineDiscounts: 0, subtotal: 1000, discount: 1000, fee: 300, total: 300, paid: 0, refunded: 0, balance: 300 });
  // Nothing set at all.
  assert.deepEqual(totals({ lines: [] }), { lines: 0, lineDiscounts: 0, subtotal: 0, discount: 0, fee: 0, total: 0, paid: 0, refunded: 0, balance: 0 });
  assert.equal(isPaid({ lines: [{ qty: 1, price: 10 }] }), false);
});

test("money: a refund on a finished order is a reduction, never a new debt", () => {
  const lines = [{ variantId: "a", qty: 1, price: 100000 }];
  const done = (payments, over = {}) => ({ status: "done", lines, payments, ...over });
  // Handed over and paid, then 30 000 given back without the goods: still paid in full.
  const part = done([{ amount: 100000 }, { amount: -30000 }]);
  assert.deepEqual(totals(part, STAGES), { lines: 100000, lineDiscounts: 0, subtotal: 100000, discount: 0, fee: 0, total: 100000, paid: 70000, refunded: 30000, balance: 0 });
  assert.equal(isPaid(part, STAGES), true);
  // All of it given back: nothing owed either.
  assert.equal(totals(done([{ amount: 100000 }, { amount: -100000 }]), STAGES).balance, 0);
  // Overpaid, then the extra given back: the balance comes back to zero, and a refund past it stays at zero.
  assert.equal(totals(done([{ amount: 120000 }]), STAGES).balance, -20000);
  assert.equal(totals(done([{ amount: 120000 }, { amount: -20000 }]), STAGES).balance, 0);
  assert.equal(totals(done([{ amount: 120000 }, { amount: -50000 }]), STAGES).balance, 0);
  // Never collected in full (an old order): a refund doesn't make the debt bigger.
  assert.equal(totals(done([{ amount: 60000 }, { amount: -20000 }]), STAGES).balance, 40000);
  // While the order is still open, or once its goods came back, money given back is owed again.
  for (const status of ["ok", "new", "off"]) assert.equal(totals({ ...part, status }, STAGES).balance, 30000, status);
  assert.equal(totals({ ...part, status: "off", returned: true }, STAGES).balance, 30000);
  assert.equal(isPaid({ ...part, status: "ok" }, STAGES), false);
  // Without the steps a sum knows nothing of the step: a draft.
  assert.equal(totals(part).balance, 30000);
});

test("stock numbers", () => {
  assert.equal(available({ stock: 5, reserved: 2 }), 3);
  assert.equal(stockState({ stock: 5, reserved: 5, lowAt: 2 }), "out");
  assert.equal(stockState({ stock: 5, reserved: 3, lowAt: 2 }), "low");
  assert.equal(stockState({ stock: 5, reserved: 0, lowAt: 2 }), "ok");
  assert.deepEqual(shortages(stock(), { a: 4, b: 3, zz: 1 }), [
    { code: "short", variantId: "b", productId: "pb", name: "Card", need: 3, free: 2, missing: 1 },
    { code: "missing_product", variantId: "zz" },
  ]);
});

test("steps: the flow, the next step, kinds", () => {
  assert.deepEqual(flowOf(STAGES).map((s) => s.id), ["new", "wait", "ok", "pack", "done"]);
  assert.equal(nextStage(STAGES, "new").id, "wait");
  assert.equal(nextStage(STAGES, "pack").id, "done");
  assert.equal(nextStage(STAGES, "done"), null);
  assert.equal(nextStage(STAGES, "off"), null);
  assert.equal(kindIn(STAGES, "gone"), "");
  assert.equal(canEditLines(STAGES, order("ok")), true);
  assert.equal(canEditLines(STAGES, order("done")), false);
  assert.equal(canEditLines(STAGES, order("off")), false);
});

// What each crossing does. `a` is on two lines (2 + 1), so three of it move as one.
const HOLD = { a: { variantId: "a", onHand: 0, reserved: 3 }, b: { variantId: "b", onHand: 0, reserved: 1 } };
const FREE = { a: { variantId: "a", onHand: 0, reserved: -3 }, b: { variantId: "b", onHand: 0, reserved: -1 } };

test("every move between kinds", async (t) => {
  const same = [["new", "wait"], ["ok", "pack"], ["pack", "ok"], ["new", "off"], ["off", "new"], ["off", "wait"]];
  for (const [from, to] of same) {
    await t.test(`${from} → ${to}: nothing moves`, () => {
      const p = move(order(from), to);
      assert.equal(p.ok, true);
      assert.equal(p.change, null);
      assert.deepEqual([p.stock, p.movements, p.pay], [[], [], 0]);
      assert.deepEqual(p.order, { status: to });
      assert.deepEqual(p.history, { text: "moved", to, toName: STAGES.find((s) => s.id === to).name });
    });
  }
  await t.test("the same step: nothing at all, no history line", () => {
    const p = move(order("ok"), "ok");
    assert.deepEqual([p.ok, p.change, p.history, p.stock], [true, null, null, []]);
  });
  for (const from of ["new", "off"]) {
    await t.test(`${from} → reserved: the lines are held`, () => {
      const p = move(order(from), "ok");
      assert.equal(p.change, "reserved");
      assert.deepEqual(byVariant(p.stock), HOLD);
      assert.deepEqual(p.movements, [{ variantId: "a", type: "reserve", qty: 3 }, { variantId: "b", type: "reserve", qty: 1 }]);
      assert.equal(p.pay, 0);
    });
    await t.test(`${from} → done: sold straight from the shelf`, () => {
      const p = move(order(from), "done");
      assert.equal(p.change, "sold");
      assert.deepEqual(byVariant(p.stock), { a: { variantId: "a", onHand: -3, reserved: 0 }, b: { variantId: "b", onHand: -1, reserved: 0 } });
      // One sale per line, as the demo writes them: the Stock page lists what left with each line.
      assert.deepEqual(p.movements, [{ variantId: "a", type: "sale", qty: -2 }, { variantId: "b", type: "sale", qty: -1 }, { variantId: "a", type: "sale", qty: -1 }]);
    });
  }
  for (const to of ["new", "off"]) {
    await t.test(`reserved → ${to}: what was held is released`, () => {
      const p = move(order("pack"), to, { note: "changed their mind" });
      assert.equal(p.change, "released");
      assert.deepEqual(byVariant(p.stock), FREE);
      assert.deepEqual(p.movements, [{ variantId: "a", type: "release", qty: -3 }, { variantId: "b", type: "release", qty: -1 }]);
      assert.equal(p.history.note, "changed their mind");
    });
  }
  await t.test("reserved → done: the held goods leave, release written before the sale", () => {
    const p = move(order("pack"), "done");
    assert.equal(p.change, "sold");
    assert.deepEqual(byVariant(p.stock), { a: { variantId: "a", onHand: -3, reserved: -3 }, b: { variantId: "b", onHand: -1, reserved: -1 } });
    assert.deepEqual(p.movements.map((m) => [m.variantId, m.type, m.qty]), [["a", "release", -3], ["b", "release", -1], ["a", "sale", -2], ["b", "sale", -1], ["a", "sale", -1]]);
    // The goods are already this order's: nothing is checked against what is available.
    const tight = move(order("pack"), "done", {}, { stock: { a: { stock: 3, reserved: 3 }, b: { stock: 1, reserved: 1 } } });
    assert.equal(tight.ok, true);
  });
  await t.test("done → cancelled: a return, the goods come back", () => {
    const p = move(order("done"), "off", { note: "wilted" });
    assert.equal(p.change, "returned");
    assert.deepEqual(p.order, { status: "off", returned: true });
    assert.deepEqual(byVariant(p.stock), { a: { variantId: "a", onHand: 3, reserved: 0 }, b: { variantId: "b", onHand: 1, reserved: 0 } });
    assert.deepEqual(p.movements, [{ variantId: "a", type: "return", qty: 2 }, { variantId: "b", type: "return", qty: 1 }, { variantId: "a", type: "return", qty: 1 }]);
    assert.deepEqual(p.history, { text: "returned", to: "off", note: "wilted" });
  });
  for (const to of ["new", "ok", "pack"]) {
    await t.test(`done → ${to}: refused, a finished order is closed`, () => assert.deepEqual(move(order("done"), to), { ok: false, missing: [{ code: "done_closed" }] }));
  }
  for (const to of ["new", "ok", "done"]) {
    await t.test(`a returned order → ${to}: refused`, () => assert.deepEqual(move(order("off", { returned: true }), to), { ok: false, missing: [{ code: "returned_closed" }] }));
  }
  await t.test("a step that doesn't exist", () => assert.deepEqual(move(order("new"), "nope"), { ok: false, missing: [{ code: "missing_stage", stage: "nope" }] }));
  await t.test("moving to the step it is in changes nothing, even when that step is gone from the list", () => {
    const p = move(order("gone"), "gone");
    assert.deepEqual([p.ok, p.change, p.history, p.stock, p.movements], [true, null, null, [], []]);
  });
  await t.test("an order in a step that is gone holds nothing", () => {
    assert.equal(move(order("gone"), "ok").change, "reserved");
    assert.equal(move(order("gone"), "off").change, null);
  });
});

test("not enough on the shelf: every short variant is named, both for holding and for selling", () => {
  const thin = { a: { stock: 3, reserved: 1, productId: "pa", name: "Roses" }, b: { stock: 0, reserved: 0, productId: "pb", name: "Card" } };
  const want = [
    { code: "short", variantId: "a", productId: "pa", name: "Roses", need: 3, free: 2, missing: 1 },
    { code: "short", variantId: "b", productId: "pb", name: "Card", need: 1, free: 0, missing: 1 },
  ];
  assert.deepEqual(move(order("new"), "ok", {}, { stock: thin }), { ok: false, missing: want });
  assert.deepEqual(move(order("new"), "done", {}, { stock: thin }), { ok: false, missing: want });
  assert.deepEqual(move(order("off"), "pack", {}, { stock: thin }), { ok: false, missing: want });
  // Exactly enough is enough.
  assert.equal(move(order("new"), "ok", {}, { stock: { a: { stock: 4, reserved: 1 }, b: { stock: 1, reserved: 0 } } }).ok, true);
  // Between reserved steps, or out of reserved, nothing is checked.
  assert.equal(move(order("ok"), "pack", {}, { stock: thin }).ok, true);
  assert.equal(move(order("ok"), "new", {}, { stock: thin }).ok, true);
});

test("an order without lines can only be open or cancelled", () => {
  const o = order("new", { lines: [] });
  assert.deepEqual(move(o, "ok"), { ok: false, missing: [{ code: "no_lines" }] });
  assert.deepEqual(move(o, "done"), { ok: false, missing: [{ code: "no_lines" }] });
  assert.equal(move(o, "wait").ok, true);
  assert.equal(move(o, "off").ok, true);
});

test("a step's needs hold for that step and every later one, never for cancelled", () => {
  const stages = STAGES.map((s) => (s.id === "ok" ? { ...s, needs: { fields: ["recipient", "call", "gone"] } } : s.id === "pack" ? { ...s, needs: { paid: true } } : s.id === "off" ? { ...s, needs: { paid: true, fields: ["recipient"] } } : s));
  assert.deepEqual(needsFor(stages, "new"), { paid: false, fields: [] });
  assert.deepEqual(needsFor(stages, "ok"), { paid: false, fields: ["recipient", "call", "gone"] });
  assert.deepEqual(needsFor(stages, "pack"), { paid: true, fields: ["recipient", "call", "gone"] });
  assert.deepEqual(needsFor(stages, "done"), { paid: true, fields: ["recipient", "call", "gone"] });
  assert.deepEqual(needsFor(stages, "off"), { paid: false, fields: [] });
  const plan = (o, to) => planMove({ stages, fields: FIELDS, order: o, stock: stock() }, to);

  // Nothing filled in: both fields are asked for (a field that no longer exists is not).
  assert.deepEqual(plan(order("new"), "ok"), { ok: false, missing: [{ code: "needs_field", field: "recipient" }, { code: "needs_field", field: "call" }] });
  // A yes or no field counts only when it says yes.
  assert.deepEqual(plan(order("new", { fields: { recipient: "Madina", call: false } }), "ok").missing, [{ code: "needs_field", field: "call" }]);
  const filled = { recipient: "Madina", call: true };
  assert.equal(plan(order("new", { fields: filled }), "ok").ok, true);
  // Earlier steps ask for nothing.
  assert.equal(plan(order("new"), "wait").ok, true);
  // The later step adds "paid" and keeps the fields of the step before it.
  assert.deepEqual(plan(order("ok", { fields: filled }), "pack").missing, [{ code: "needs_paid" }]);
  assert.deepEqual(plan(order("new"), "done").missing, [{ code: "needs_paid" }, { code: "needs_field", field: "recipient" }, { code: "needs_field", field: "call" }]);
  // Paid in full by its payments, or said to be paid by the caller.
  const paid = order("ok", { fields: filled, payments: [{ amount: 3400 }] });
  assert.equal(totals(paid).balance, 0);
  assert.equal(plan(paid, "pack").ok, true);
  assert.equal(plan(order("ok", { fields: filled, payments: [{ amount: 3399 }] }), "pack").ok, false);
  assert.equal(plan(order("ok", { fields: filled, paid: true, payments: undefined }), "pack").ok, true);
  // Cancelling never asks for anything.
  assert.equal(plan(order("ok"), "off").ok, true);
  assert.equal(plan(order("new"), "off").ok, true);
  // A need and a shortage are reported together.
  const both = planMove({ stages, fields: FIELDS, order: order("new", { fields: { recipient: "M" } }), stock: { a: { stock: 0, reserved: 0 }, b: { stock: 9, reserved: 0 } } }, "ok");
  assert.deepEqual(both.missing.map((r) => r.code), ["needs_field", "short"]);
  assert.deepEqual(missingFor(stages, FIELDS, order("new", { fields: filled, paid: true }), "done"), []);
});

test("handing over settles what is still owed", () => {
  assert.equal(move(order("ok"), "done").pay, 3400);
  assert.equal(move(order("ok", { payments: [{ amount: 1400 }] }), "done").pay, 2000);
  assert.equal(move(order("ok", { payments: [{ amount: 3400 }] }), "done").pay, 0);
  assert.equal(move(order("ok", { payments: [{ amount: 9000 }] }), "done").pay, 0);
  assert.equal(move(order("ok", { discount: 400, delivery: { fee: 1000 } }), "done").pay, 4000);
  // Money given back while the order was open is owed again when it is handed over.
  assert.equal(move(order("ok", { payments: [{ amount: 3400 }, { amount: -400 }] }), "done").pay, 400);
  // What handing over takes, the history says, as a payment taken by hand does.
  assert.deepEqual(move(order("ok", { payment: "cash", payments: [{ amount: 1400 }] }), "done").paid, { text: "paid", amount: 2000, method: "cash" });
  assert.equal(move(order("ok", { payments: [{ amount: 3400 }] }), "done").paid, null);
});

test("required fields", () => {
  assert.deepEqual(requiredMissing(FIELDS, {}), [{ code: "field_required", field: "must" }]);
  assert.deepEqual(requiredMissing(FIELDS, { must: "x" }), []);
});

test("changing the lines of an order", () => {
  const plan = (o, lines, s = stock()) => planLines({ stages: STAGES, order: o, stock: s }, lines);
  // Not accepted yet: nothing is held, so nothing moves.
  const open = plan(order("new"), [{ variantId: "a", qty: 50, price: 1 }, { variantId: "b", qty: 0, price: 1 }]);
  assert.deepEqual([open.ok, open.stock, open.movements], [true, [], []]);
  assert.deepEqual(open.lines, [{ variantId: "a", qty: 50, price: 1 }]);
  assert.deepEqual(open.history, { text: "edited" });
  // Accepted: the reservation follows. a: 3 → 5 (+2), b: 1 → 0 (-1), c: new (+1).
  const s = { ...stock(), c: { stock: 1, reserved: 0, productId: "pc", name: "Vase" } };
  const held = plan(order("ok"), [{ variantId: "a", qty: 5, price: 1000 }, { variantId: "c", qty: 1, price: 10 }], { ...s, a: { stock: 9, reserved: 3 } });
  assert.equal(held.ok, true);
  assert.deepEqual(byVariant(held.stock), { a: { variantId: "a", onHand: 0, reserved: 2 }, b: { variantId: "b", onHand: 0, reserved: -1 }, c: { variantId: "c", onHand: 0, reserved: 1 } });
  assert.deepEqual(byVariant(held.movements), { a: { variantId: "a", type: "reserve", qty: 2 }, b: { variantId: "b", type: "release", qty: -1 }, c: { variantId: "c", type: "reserve", qty: 1 } });
  // Only the extra is checked against what is free (a: 5 on hand, 4 held → 1 free, 2 more wanted).
  assert.deepEqual(plan(order("ok"), [{ variantId: "a", qty: 5, price: 1000 }], { a: { stock: 5, reserved: 4, productId: "pa", name: "Roses" }, b: { stock: 2, reserved: 1 } }), {
    ok: false,
    missing: [{ code: "short", variantId: "a", productId: "pa", name: "Roses", need: 2, free: 1, missing: 1 }],
  });
  // The same quantities at another price: nothing to hold or release.
  assert.deepEqual(plan(order("ok"), [{ variantId: "a", qty: 3, price: 1 }, { variantId: "b", qty: 1, price: 1 }]).stock, []);
  // Closed orders, and an order left with nothing.
  assert.deepEqual(plan(order("done"), [{ variantId: "a", qty: 1, price: 1 }]), { ok: false, missing: [{ code: "lines_locked" }] });
  assert.deepEqual(plan(order("off"), [{ variantId: "a", qty: 1, price: 1 }]), { ok: false, missing: [{ code: "lines_locked" }] });
  assert.deepEqual(plan(order("ok"), [{ variantId: "a", qty: 0, price: 1 }]), { ok: false, missing: [{ code: "no_lines" }] });
});

test("writing off and counting stock", () => {
  const row = { variantId: "a", productId: "pa", name: "Roses", stock: 5, reserved: 2 };
  assert.deepEqual(planWriteOff(row, 3), { ok: true, stock: [{ variantId: "a", onHand: -3, reserved: 0 }], movements: [{ variantId: "a", type: "writeoff", qty: -3 }] });
  assert.deepEqual(planWriteOff(row, 4).missing, [{ code: "write_off_short", variantId: "a", productId: "pa", name: "Roses", free: 3, reserved: 2 }]);
  assert.deepEqual(planWriteOff(row, 0).missing, [{ code: "qty" }]);
  assert.deepEqual(planWriteOff(null, 1).missing, [{ code: "missing_product" }]);
  assert.deepEqual(planCount(row, 9), { ok: true, diff: 4, stock: [{ variantId: "a", onHand: 4, reserved: 0 }], movements: [{ variantId: "a", type: "adjust", qty: 4 }] });
  assert.equal(planCount(row, 2).diff, -3);
  assert.deepEqual(planCount(row, 1).missing, [{ code: "below_reserved", variantId: "a", productId: "pa", name: "Roses", reserved: 2 }]);
  assert.deepEqual(planCount(row, 5).missing, [{ code: "no_difference", variantId: "a", productId: "pa", name: "Roses" }]);
  assert.deepEqual(planCount(row, -1).missing, [{ code: "qty" }]);
});

// 2026-11-17 is a Tuesday.
const NOW = "2026-11-17T13:00";
const RULES = { time: "both", windows: [{ from: "09:00", to: "12:00" }, { from: "12:00", to: "15:00" }, { from: "15:00", to: "18:00" }, { from: "18:00", to: "21:00" }], daysOff: [0], closed: [{ date: "2026-11-20", note: "Stock count" }], sameDayUntil: "18:00", prepMinutes: 90, maxDays: 30, override: true };
const check = (d, now = NOW, rules = RULES) => checkDelivery({ slot: "", time: "", ...d }, rules, now);
const fine = { hard: [], soft: [] };

test("delivery rules: every reason, both ways", async (t) => {
  await t.test("no day yet: nothing to check", () => assert.deepEqual(check({ date: "" }), fine));
  await t.test("a day that has passed is hard; today and later are not", () => {
    assert.deepEqual(check({ date: "2026-11-16", time: "10:00" }), { hard: [{ code: "past_day" }], soft: [] });
    assert.deepEqual(check({ date: "2026-11-17", time: "16:00" }), fine);
    assert.deepEqual(check({ date: "2026-11-18", time: "08:00" }), fine);
  });
  await t.test("a closed date", () => {
    assert.deepEqual(check({ date: "2026-11-20", slot: "12:00–15:00" }).soft, [{ code: "closed_day", date: "2026-11-20", note: "Stock count" }]);
    assert.deepEqual(check({ date: "2026-11-21", slot: "12:00–15:00" }), fine);
  });
  await t.test("a weekday without delivery", () => {
    assert.deepEqual(check({ date: "2026-11-22" }).soft, [{ code: "day_off", weekday: 0 }]);
    assert.deepEqual(check({ date: "2026-11-23" }), fine);
  });
  await t.test("too far ahead", () => {
    assert.deepEqual(check({ date: "2026-12-17" }), fine); // exactly maxDays ahead
    assert.deepEqual(check({ date: "2026-12-18" }).soft, [{ code: "too_far", maxDays: 30 }]);
    assert.deepEqual(check({ date: "2027-12-18" }, NOW, { ...RULES, maxDays: 0 }), fine);
  });
  await t.test("today after the same-day cutoff", () => {
    assert.deepEqual(check({ date: "2026-11-17", time: "20:30" }, "2026-11-17T18:01").soft, [{ code: "after_cutoff", time: "18:00" }]);
    assert.deepEqual(check({ date: "2026-11-17", time: "20:30" }, "2026-11-17T18:00"), fine);
    assert.deepEqual(check({ date: "2026-11-18", time: "10:00" }, "2026-11-17T18:01"), fine);
    assert.deepEqual(check({ date: "2026-11-17", time: "22:00" }, "2026-11-17T20:00", { ...RULES, sameDayUntil: "" }), fine);
  });
  await t.test("a time or a window that is already over today", () => {
    assert.deepEqual(check({ date: "2026-11-17", time: "12:59" }).soft, [{ code: "time_passed" }]);
    assert.deepEqual(check({ date: "2026-11-17", time: "13:00" }).soft, [{ code: "time_passed" }]);
    assert.deepEqual(check({ date: "2026-11-17", slot: "09:00–12:00" }).soft, [{ code: "window_ended" }]);
    assert.deepEqual(check({ date: "2026-11-18", slot: "09:00–12:00" }), fine);
  });
  await t.test("less than the preparation time from now", () => {
    assert.deepEqual(check({ date: "2026-11-17", time: "14:29" }).soft, [{ code: "too_soon", prepMinutes: 90, earliest: "14:30" }]);
    assert.deepEqual(check({ date: "2026-11-17", time: "14:30" }), fine);
    // A window counts by its end: 12:00–15:00 still leaves two hours at 13:00, but not at 13:45.
    assert.deepEqual(check({ date: "2026-11-17", slot: "12:00–15:00" }), fine);
    assert.deepEqual(check({ date: "2026-11-17", slot: "12:00–15:00" }, "2026-11-17T13:45").soft, [{ code: "too_soon", prepMinutes: 90, earliest: "15:15" }]);
    assert.deepEqual(check({ date: "2026-11-17", time: "13:05" }, NOW, { ...RULES, prepMinutes: 0 }), fine);
    assert.deepEqual(check({ date: "2026-11-18", time: "00:10" }, "2026-11-17T23:50"), fine); // tomorrow is not measured
  });
  await t.test("a day's own problem comes alone, without the time's", () => {
    assert.deepEqual(check({ date: "2026-11-17", time: "18:30" }, "2026-11-17T18:20").soft, [{ code: "after_cutoff", time: "18:00" }]);
  });
  await t.test("with no rules set, only the past is refused", () => {
    assert.deepEqual(checkDelivery({ date: "2026-11-22", time: "23:00" }, undefined, NOW), fine);
    assert.deepEqual(checkDelivery({ date: "2026-11-17", time: "09:00" }, {}, NOW).soft, [{ code: "time_passed" }]);
    assert.equal(rulesOf(undefined).override, true);
  });
});

test("delivery rules: who may pass them", () => {
  const soft = check({ date: "2026-11-22" });
  const hard = check({ date: "2026-11-10" });
  assert.equal(deliveryAllowed(fine, RULES, false), true);
  assert.equal(deliveryAllowed(soft, RULES, false), false);
  assert.equal(deliveryAllowed(soft, RULES, true), true);
  assert.equal(deliveryAllowed(soft, { ...RULES, override: false }, true), false);
  assert.equal(deliveryAllowed(hard, RULES, true), false);
});

test("delivery: what is offered", () => {
  assert.equal(dayProblem(RULES, "2026-11-18", NOW), null);
  assert.deepEqual(windowsFor(RULES, "2026-11-17", NOW).map(windowText), ["12:00–15:00", "15:00–18:00", "18:00–21:00"]);
  assert.equal(windowsFor(RULES, "2026-11-18", NOW).length, 4);
  assert.equal(earliestToday(RULES, NOW), "14:30");
  assert.equal(earliestToday({ ...RULES, prepMinutes: 0 }, NOW), "");
  // The first window today that leaves time to prepare.
  assert.deepEqual(suggestDelivery(RULES, NOW), { date: "2026-11-17", slot: "12:00–15:00", time: "" });
  assert.deepEqual(suggestDelivery(RULES, "2026-11-17T13:45"), { date: "2026-11-17", slot: "15:00–18:00", time: "" });
  // After the cutoff: tomorrow's first window.
  assert.deepEqual(suggestDelivery(RULES, "2026-11-17T19:00"), { date: "2026-11-18", slot: "09:00–12:00", time: "" });
  // Exact times: the earliest ready time, on a five minute mark; tomorrow from the opening time.
  assert.deepEqual(suggestDelivery({ ...RULES, time: "exact" }, "2026-11-17T13:02"), { date: "2026-11-17", slot: "", time: "14:35" });
  assert.deepEqual(suggestDelivery({ ...RULES, time: "exact" }, "2026-11-17T19:00", "09:00"), { date: "2026-11-18", slot: "", time: "09:00" });
  // Windows and exact times both: the first exact time can be asked for too.
  assert.deepEqual(suggestDelivery(RULES, "2026-11-17T13:02", "10:00", { exact: true }), { date: "2026-11-17", slot: "", time: "14:35" });
  assert.deepEqual(suggestDelivery(RULES, "2026-11-17T19:00", "09:00", { exact: true }), { date: "2026-11-18", slot: "", time: "09:00" });
  // Saturday evening, Sunday off: Monday.
  assert.deepEqual(suggestDelivery(RULES, "2026-11-21T19:00"), { date: "2026-11-23", slot: "09:00–12:00", time: "" });
  assert.equal(K.reserved, "reserved");
});
