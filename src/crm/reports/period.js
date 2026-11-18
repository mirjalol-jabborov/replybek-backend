// What every report covers: days on the business's wall clock, `from` and `to` both included,
// and optionally one branch. The SQL reads the half-open span [from, the day after to).
import { z } from "zod";
import { day, uuid } from "../shapes.js";
import { addDays, daysBetween } from "../shared/time.js";
import { stageIds } from "../shared/index.js";
import { narrowTo } from "../branches/access.js";

/** The longest span a report takes: two years. */
export const MAX_DAYS = 731;

const span = { message: "From comes before to, at most two years apart.", params: { code: "bad_span" }, path: ["to"] };
const fits = (v) => v.from <= v.to && daysBetween(v.from, v.to) < MAX_DAYS;
const base = { from: day, to: day, branch: uuid.optional() };

export const periodSchema = z.object(base).strict().refine(fits, span);
/** Income also says how its rows are grouped: by day, week (Monday to Sunday) or month. */
export const incomeSchema = z.object({ ...base, by: z.enum(["day", "week", "month"]).default("day") }).strict().refine(fits, span);

/**
 * The period as the queries take it: { from, end (the day after `to`), branch | null }. A branch
 * must be the workspace's (400 bad_branch). Reports are for admins, who are never limited to a branch.
 */
export async function periodOf(q, cfg, input) {
  return { from: input.from, end: addDays(input.to, 1), branch: await narrowTo(q, cfg, input.branch, null) };
}

/** The ids of the booking steps of these kinds, from the workspace's own list: a report counts by kind, never by a step id. */
export const apptSteps = (cfg, ...kinds) => stageIds(cfg.data.apptStages, ...kinds);

/** Each booking step's kind as a JSON object { stepId: kind }, for SQL that groups by kind. */
export const apptKinds = (cfg) => JSON.stringify(Object.fromEntries((cfg.data.apptStages || []).map((s) => [s.id, s.kind])));

/** part / whole as a share from 0 to 1, four places; null when there is nothing to divide by. */
export const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 10000) / 10000 : null);

/** A sum of money divided by a count, in whole soʻm; 0 when the count is 0. */
export const average = (sum, n) => (n > 0 ? Math.round(sum / n) : 0);
