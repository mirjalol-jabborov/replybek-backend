// Reading the lists a business sets for itself (the steps of a board, sources, tags, fields).
// Pure functions on the shapes the app reads; the app keeps a copy of this folder (see CONTRACT.md,
// "Shared rules"). Nothing here knows about one kind of business: logic goes by a step's kind.

/** A stage by id; an unknown id (a removed stage) still reads, with no kind. */
export const stageOf = (stages, id) => (stages || []).find((s) => s.id === id) || { id, name: id, tone: "", kind: "" };
/** Ids of the stages of these kinds: stageIds(db.orderStages, "open", "reserved"). */
export const stageIds = (stages, ...kinds) => (stages || []).filter((s) => kinds.includes(s.kind)).map((s) => s.id);
/** The kind of the stage an item is in: kindOf(db.orderStages, order.status) → "reserved". */
export const kindOf = (stages, id) => stageOf(stages, id).kind;
/** The first stage of a kind (the one "done" or "cancelled" stage, or the first open one). */
export const firstOf = (stages, kind) => (stages || []).find((s) => s.kind === kind);
/** Whether a list has an item with this id. */
export const hasId = (list, id) => (list || []).some((x) => x.id === id);
/** Ids that were in `before` and are not in `after`. */
export const removedIds = (before, after) => (before || []).filter((x) => !hasId(after, x.id)).map((x) => x.id);

/**
 * What a step can mean to the system. A `fixed` kind has exactly one step, which can be renamed
 * but not removed. A kind with `min: 1` keeps at least one step.
 */
export const APPT_KINDS = [
  { value: "pending" },
  { value: "booked", min: 1 },
  { value: "here" },
  { value: "done", fixed: true },
  { value: "noshow", fixed: true },
  { value: "cancelled", fixed: true },
];
export const ORDER_KINDS = [
  { value: "open", min: 1 },
  { value: "reserved" },
  { value: "done", fixed: true },
  { value: "cancelled", fixed: true },
];

/** Where the items of a removed step end up: moves are followed in order (a → b, then b → c). */
export const moveTarget = (moves, id) => (moves || []).reduce((cur, m) => (m.from === cur ? m.to : cur), id);

/**
 * Checks an edit of a board's steps. Editing the board must never change stock or free a time by
 * surprise, so a step with items in it keeps its meaning: its kind can't change, and it can only
 * be removed into a step of the same kind.
 * kinds: APPT_KINDS | ORDER_KINDS; before, after: the lists; moves: [{ from, to }];
 * countOf(stageId) → how many items are in it now.
 * Returns the problems: [{ code, id?, kind?, count?, to? }]. Empty when the edit is fine.
 *   stage_fixed      the one step of a fixed kind was removed, replaced or doubled
 *   stage_min        a kind that needs a step has none
 *   stage_in_use     a step with items changed its kind
 *   stage_needs_move a step with items was removed without saying where they go
 *   bad_move         a move starts at a step that stays, or ends at a missing step or another kind
 */
export function checkStages({ kinds, before, after, moves = [], countOf = () => 0 }) {
  const problems = [];
  for (const k of kinds) {
    const now = after.filter((s) => s.kind === k.value);
    if (k.fixed) {
      const was = before.filter((s) => s.kind === k.value);
      if (now.length !== 1 || (was.length === 1 && was[0].id !== now[0].id)) problems.push({ code: "stage_fixed", kind: k.value });
    } else if (k.min && now.length < k.min) problems.push({ code: "stage_min", kind: k.value });
  }
  for (const m of moves) {
    if (hasId(after, m.from) || !hasId(before, m.from)) problems.push({ code: "bad_move", id: m.from, to: m.to });
  }
  for (const s of before) {
    const next = after.find((x) => x.id === s.id);
    if (next) {
      if (next.kind !== s.kind && countOf(s.id) > 0) problems.push({ code: "stage_in_use", id: s.id, count: countOf(s.id) });
      continue;
    }
    const to = moveTarget(moves, s.id);
    if (to === s.id) {
      if (countOf(s.id) > 0) problems.push({ code: "stage_needs_move", id: s.id, count: countOf(s.id) });
    } else if (kindOf(after, to) !== s.kind) problems.push({ code: "bad_move", id: s.id, to });
  }
  return problems;
}
