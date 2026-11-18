// Branches: the places a business works from. Plain functions of the workspace's data, mirrored to
// the app. A branch is { id, name, address, phone, hours, active, default }: `hours` are its own
// working days and hours ({ "0".."6": ["09:00", "18:00"] | null }, 0 = Sunday) or null when it
// sets none, and a closed branch (`active: false`) takes no new work. A specialist, a booking and
// time off carry `branchId`; rows written before branches (or test data without it) have none and
// count as everywhere, so a one-place business reads exactly as before.
import { toMin, weekday } from "./time.js";

/** The branch a specialist works at, from db.branches, or null when it isn't known. */
export const placeOf = (db, person) => (person?.branchId && (db?.branches || []).find((b) => b.id === person.branchId)) || null;

/**
 * Working minutes [from, to] of a day cut to the branch's own hours, when it sets them: null when
 * the branch is closed that weekday or nothing of the span is left.
 */
export function withinBranch(span, branch, day) {
  if (!span || !branch?.hours) return span;
  const h = branch.hours[weekday(day)];
  if (!h) return null;
  const from = Math.max(span[0], toMin(h[0]));
  const to = Math.min(span[1], toMin(h[1]));
  return from < to ? [from, to] : null;
}

/**
 * Whether a time-off entry is about a specialist (or, with staffId null, a place): their own, or a
 * closed day of their branch. A closed day of another branch is not; one without a branch, or a
 * question without one, counts everywhere.
 */
export const offFor = (o, staffId, branchId) => (o.staffId ? o.staffId === staffId : !o.branchId || !branchId || o.branchId === branchId);

/** The rules' data with only one branch's specialists, for "anyone" there. No branch: everyone. */
export const poolOf = (db, branchId) => (branchId ? { ...db, staff: (db.staff || []).filter((p) => p.branchId === branchId) } : db);

/**
 * Moving goods from one branch to another: `stock` is the sending branch's ({ [variantId]: { variantId,
 * productId, name, stock, reserved } }), `items` [{ variantId, qty }] (one variant may come twice).
 * Only what is free there can go: held goods belong to orders. Returns { ok: true, movements } with
 * a pair of ledger lines per variant (`side`: "from" leaves the sending branch, "to" reaches the
 * other), or { ok: false, missing: [{ code: "transfer_short", variantId, productId, name, need, free, reserved }] }.
 */
export function planTransfer(stock, items) {
  const need = new Map();
  for (const i of items) need.set(i.variantId, (need.get(i.variantId) || 0) + i.qty);
  const missing = [];
  for (const [variantId, qty] of need) {
    const row = stock[variantId];
    const free = Math.max(0, row.stock - row.reserved);
    if (qty > free) missing.push({ code: "transfer_short", variantId, productId: row.productId, name: row.name, need: qty, free, reserved: row.reserved });
  }
  if (missing.length) return { ok: false, missing };
  const movements = [...need].flatMap(([variantId, qty]) => [
    { variantId, type: "transfer", qty: -qty, side: "from" },
    { variantId, type: "transfer", qty, side: "to" },
  ]);
  return { ok: true, movements };
}
