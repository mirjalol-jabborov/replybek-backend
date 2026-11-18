// Bookings outside the snapshot's window: the calendar or a week before it, one specialist's, one
// customer's, a page at a time. Rows in the snapshot's shape, so the app merges them as they come.
import { z } from "zod";
import { forbidden } from "../../core/http.js";
import { read, pageOf } from "../db.js";
import { uuid, day } from "../shapes.js";
import { daysBetween } from "../shared/time.js";
import { narrowTo } from "../branches/index.js";
import { listAppointments } from "./rows.js";
import { linkOf } from "./staff.js";

/** The longest span one question covers. */
const MAX_DAYS = 366;

export const browseSchema = z
  .object({
    from: day,
    to: day,
    staffId: uuid,
    customerId: uuid,
    branch: z.string(), // checked as the snapshot checks it: 400 bad_branch, 403 other_branch
    // The id of the last booking of the page before.
    after: uuid,
    limit: z.coerce.number().int().min(1).max(1000),
  })
  .partial()
  .strict()
  .refine((v) => (v.from && v.to) || v.customerId, { message: "Give from and to, or a customer.", params: { code: "bad_span" }, path: ["from"] })
  .refine((v) => !v.from || !v.to || (v.from <= v.to && daysBetween(v.from, v.to) < MAX_DAYS), { message: "From comes before to, at most a year apart.", params: { code: "bad_span" }, path: ["to"] });

/**
 * { appointments, next } in the calendar's order. A team member who sees only their own bookings
 * gets only theirs (naming another specialist is 403, as on the calendar). ?branch= narrows to one
 * branch as the snapshot does; a team member limited to a branch gets that branch's.
 */
export function browseAppointments(workspaceId, who, { limit = 500, branch, ...where }) {
  return read(workspaceId, async (q, cfg) => {
    const { only } = await linkOf(q, workspaceId, who);
    if (only && where.staffId && where.staffId !== only) throw forbidden("You can see only your own calendar.");
    const rows = await listAppointments(q, cfg, { ...where, staffId: only || where.staffId, branchId: await narrowTo(q, cfg, branch, who.branchOnly), limit: limit + 1 });
    const page = pageOf(rows, limit);
    return { appointments: page.rows, next: page.next };
  });
}
