// Questions about time, answered without saving anything: may this visit happen, and which start
// times would a customer be offered on a day. They run the same shared functions the writes run.
import { z } from "zod";
import { forbidden } from "../../lib/http.js";
import { read, load } from "../db.js";
import { check, verdict, assign, freeStarts, whyNone, totals, rulesOf, isClean } from "../shared/booking.js";
import { dayOf, fromMin } from "../shared/time.js";
import { uuid, serviceList, day, moment, minutes } from "./shapes.js";
import { linkOf, loadRules } from "./rows.js";

export const checkSchema = z
  .object({
    staffId: uuid.nullable(), // null: anyone
    serviceIds: serviceList,
    start: moment,
    duration: minutes, // left out: the services' own
    ignoreId: uuid, // the booking being moved, so it doesn't block itself
    by: z.enum(["team", "customer"]),
  })
  .partial()
  .required({ serviceIds: true, start: true })
  .strict();
const csv = z.string().transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)).pipe(z.array(uuid).min(1).max(20));
export const slotsSchema = z.object({ day, serviceIds: csv, staffId: uuid.optional(), duration: z.coerce.number().int().min(1).max(1440).optional(), ignoreId: uuid.optional() }).strict();

/**
 * Whose calendar a question is about: the specialist asked for, or null for anyone. A team member
 * who works only with their own bookings asks only about their own: "anyone" means them, and
 * another's calendar is refused, as their writes are, so a taken time never shows them another's booking.
 */
async function askedFor(q, workspaceId, who, staffId) {
  const me = await linkOf(q, workspaceId, who);
  if (me.only && staffId && staffId !== me.only) throw forbidden("You can see only your own calendar.");
  return staffId || me.only || null;
}

/**
 * What the rules say about a visit: { staffId, duration, hard, soft, ok, canForce }.
 * staffId null in the question = anyone; the answer names who would take it.
 * by "customer": as the website or the AI agent would be judged (the start-time grid counts, nothing can be forced).
 */
export function checkDraft(workspaceId, who, body) {
  return read(async (q) => {
    const cfg = await load(workspaceId, q);
    const asked = await askedFor(q, workspaceId, who, body.staffId);
    const db = await loadRules(q, cfg, dayOf(body.start), dayOf(body.start));
    const by = body.by || "team";
    const opts = { by, now: cfg.now };
    const draft = { staffId: asked, serviceIds: body.serviceIds, start: body.start, duration: body.duration ?? totals(db, body.serviceIds).duration, ignoreId: body.ignoreId };
    const { staffId, result } = draft.staffId ? { staffId: draft.staffId, result: check(db, draft, opts) } : assign(db, draft, opts);
    const ok = isClean(result);
    return { staffId, duration: draft.duration, hard: result.hard, soft: result.soft, ok, canForce: !ok && verdict(db, result, { by, force: true }) === "ok" };
  });
}

/**
 * The start times a customer would be offered on a day: { day, duration, step, slots: [{ min, time, staffId }], none }.
 * `none` is the one reason the list is empty (see whyNone), null when there are times.
 */
export function slots(workspaceId, who, ask) {
  return read(async (q) => {
    const cfg = await load(workspaceId, q);
    const staffId = await askedFor(q, workspaceId, who, ask.staffId);
    const db = await loadRules(q, cfg, ask.day, ask.day);
    const duration = ask.duration ?? totals(db, ask.serviceIds).duration;
    const query = { staffId, serviceIds: ask.serviceIds, day: ask.day, duration, ignoreId: ask.ignoreId };
    const list = freeStarts(db, query, { now: cfg.now }).map((s) => ({ ...s, time: fromMin(s.min) }));
    return { day: ask.day, duration, step: rulesOf(db).step, slots: list, none: list.length ? null : whyNone(db, query, { now: cfg.now }) };
  });
}
