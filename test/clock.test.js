import assert from "node:assert/strict";
import { test } from "node:test";
import { describeNow, validTimeZone } from "../src/lib/clock.js";

test("the customer's local date, weekday, time and offset", () => {
  const at = new Date("2026-11-11T20:30:00Z");
  assert.equal(describeNow("Asia/Tashkent", at), "Thursday 2026-11-12, 01:30 (Asia/Tashkent, GMT+5)", "past midnight in Tashkent it's already tomorrow");
  assert.equal(describeNow("Europe/Moscow", at), "Wednesday 2026-11-11, 23:30 (Europe/Moscow, GMT+3)");
});

test("an unknown or missing time zone falls back to UTC", () => {
  assert.equal(validTimeZone("Mars/Base"), null);
  assert.equal(validTimeZone(""), null);
  assert.equal(validTimeZone(" Asia/Tashkent "), "Asia/Tashkent");
  assert.match(describeNow("Mars/Base", new Date("2026-11-11T20:30:00Z")), /^Wednesday 2026-11-11, 20:30 \(UTC/);
});
