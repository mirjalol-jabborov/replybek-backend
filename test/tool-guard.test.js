import assert from "node:assert/strict";
import { test } from "node:test";
import { inventedIds, withEmptyHint } from "../src/lib/tool-guard.js";

test("an order number nobody gave is caught; one the customer wrote is not", () => {
  assert.deepEqual(inventedIds({ order_id: "123456" }, "where is my order?"), ["order_id"]);
  assert.deepEqual(inventedIds({ order_id: "4127" }, "4127 buyurtmam qayerda?"), []);
  assert.deepEqual(inventedIds({ order_id: "4127" }, "Order #4127 arrives Wednesday"), [], "an earlier reply or tool result counts");
});

test("phones match however they were written, with or without the country code", () => {
  assert.deepEqual(inventedIds({ phone: "998901234567" }, "raqamim 90 123 45 67"), []);
  assert.deepEqual(inventedIds({ phone: "+998 90 123 45 67" }, "my number is 901234567"), []);
  assert.deepEqual(inventedIds({ phone: "998901112233" }, "my number is 901234567"), ["phone"]);
});

test("only identifiers are checked: quantities, dates, prices and search words pass", () => {
  const args = { quantity: 1000, date: "2026-11-22", price: 890000, query: "trail runner 42", order_id: "4127" };
  assert.deepEqual(inventedIds(args, "move order 4127 to Friday, a thousand pieces"), []);
});

test("identifiers inside lists and nested objects are checked too", () => {
  const args = { items: [{ productId: "5521", quantity: 2 }, { productId: "7781", quantity: 1 }] };
  assert.deepEqual(inventedIds(args, "add product 5521 twice"), ["productId"]);
});

test("short numbers and values without digits are left alone", () => {
  assert.deepEqual(inventedIds({ order_id: "8", sku: "AJ" }, "hello"), []);
});

test("an empty lookup gets a note to search again; anything else is unchanged", () => {
  assert.match(withEmptyHint([]).note, /Try once more/);
  assert.deepEqual(withEmptyHint([]).result, []);
  assert.match(withEmptyHint({ rows: [], total: 0 }).note, /Try once more/);
  assert.deepEqual(withEmptyHint([{ name: "Wool hat" }]), [{ name: "Wool hat" }]);
  assert.deepEqual(withEmptyHint({ status: "Delivered" }), { status: "Delivered" });
  assert.equal(withEmptyHint(null), null);
});
