// Moving a booking between the workspace's own steps. What a step allows comes from its kind
// (pending, booked, here, done, noshow, cancelled), never from its id or name.
import { z } from "zod";
import { HttpError } from "../../core/http.js";
import { write } from "../db.js";
import { hasId, stageOf, kindOf } from "../shared/index.js";
import { check, verdict, stepBlock, kindHolds, CLOSED_KINDS } from "../shared/booking.js";
import { dayOf } from "../shared/time.js";
import { loadRules } from "./rows.js";
import { linkOf } from "./staff.js";
import { getAppointment, saveAppointment, entry, refuse } from "./appointments.js";

// force: bringing a cancelled or missed booking back over the business's rules, as when booking.
export const stepSchema = z.object({ status: z.string().min(1).max(40), reason: z.string().trim().max(500).optional(), force: z.boolean().optional() }).strict();

/**
 * The start a cancelled or missed booking had when it closed. Read from its history: going back
 * through the lines since the step that closed it, the earliest move says where it was.
 */
function startWhenClosed(stages, a) {
  let start = a.start;
  for (const line of [...(a.history || [])].reverse()) {
    if (line.type === "moved") start = line.from;
    if (line.type === "status" && !CLOSED_KINDS.includes(kindOf(stages, line.from))) break;
  }
  return start;
}
// What only says the visit's time has come or gone. A booking brought back at the time it had was
// booked once already, so these don't count for it: a missed visit may be put back (marked missed by mistake, it did happen).
const TIME_GONE = ["day_passed", "time_passed", "min_notice"];

/**
 * Puts a booking into another step, by what the step means: "here" only on the day of the visit,
 * "done" from that day on, "noshow" only after the start. A finished visit is marked paid.
 * Bringing a cancelled or missed booking back takes its time again, so it is judged like a new
 * booking at that time (force passes the soft reasons, when override is on). Answers { changes, forced? }.
 */
export function stepAppointment(workspaceId, who, id, body) {
  return write(workspaceId, async (c, cfg, q) => {
    const a = await getAppointment(q, cfg, id, await linkOf(q, workspaceId, who));
    const stages = cfg.data.apptStages;
    if (!hasId(stages, body.status)) throw new HttpError(400, "This step no longer exists.", { code: "bad_step" });
    if (a.status === body.status) return { changes: {} };
    const to = stageOf(stages, body.status);
    const from = stageOf(stages, a.status);
    const block = stepBlock(stages, a, to.id, cfg.now);
    if (block) throw refuse(cfg, { hard: [block], soft: [] }, "This booking can't go into that step now.");
    let soft = [];
    if (CLOSED_KINDS.includes(from.kind) && kindHolds(to.kind)) {
      const db = await loadRules(q, cfg, dayOf(a.start), dayOf(a.start));
      const result = check(db, { ...a, ignoreId: a.id }, { by: "team", now: cfg.now });
      // Moved while it was closed, it is a new time like any other.
      if (startWhenClosed(stages, a) === a.start) {
        result.hard = result.hard.filter((r) => !TIME_GONE.includes(r.code));
        result.soft = result.soft.filter((r) => !TIME_GONE.includes(r.code));
      }
      if (verdict(db, result, { by: "team", force: body.force }) !== "ok") throw refuse(cfg, result);
      soft = result.soft;
    }
    const patch = { status: to.id, busy: kindHolds(to.kind), history: [...a.history, entry(cfg, who, { type: "status", from: a.status, to: to.id, reason: body.reason || "" })] };
    if (to.kind === "done" && !a.paid) patch.paid = true;
    const row = await saveAppointment(c, cfg, a, patch);
    return { changes: { set: { appointments: [row] } }, ...(soft.length ? { forced: soft } : {}) };
  });
}
