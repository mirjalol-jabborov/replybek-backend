// Orders and stock movements outside the snapshot's window: older ones, one customer's, one
// product's, a page at a time. Rows in the snapshot's shape, so the app merges them as they come.
// ?branch= narrows to one branch as the snapshot does; a team member limited to a branch gets that branch's.
import { z } from "zod";
import { read, pageOf } from "../db.js";
import { uuid, day } from "../shapes.js";
import { narrowTo } from "../branches/index.js";
import { listOrders, pageMovements } from "./rows.js";

const limit = z.coerce.number().int().min(1).max(500);

export const ordersSchema = z
  .object({
    from: day, // made on this day or later
    to: day, // made on this day or earlier
    customerId: uuid,
    branch: z.string(), // checked as the snapshot checks it: 400 bad_branch, 403 other_branch
    before: uuid, // the id of the last order of the page before
    limit,
  })
  .partial()
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: "From comes before to.", params: { code: "bad_span" }, path: ["to"] });

export const movementsSchema = z
  .object({
    productId: uuid,
    branch: z.string(), // checked as the snapshot checks it: 400 bad_branch, 403 other_branch
    before: uuid, // the id of the last movement of the page before
    limit,
  })
  .partial()
  .strict();

/** Orders newest first: { orders, next }. */
export function browseOrders(workspaceId, user, { limit: n = 200, branch, ...where }) {
  return read(workspaceId, async (q, cfg) => {
    const branchId = await narrowTo(q, cfg, branch, user.branchOnly);
    const page = pageOf(await listOrders(q, cfg, { ...where, branchId, limit: n + 1 }), n);
    return { orders: page.rows, next: page.next };
  });
}

/** Stock movements newest first: { movements, next }. */
export function browseMovements(workspaceId, user, { limit: n = 200, branch, ...where }) {
  return read(workspaceId, async (q, cfg) => pageMovements(q, cfg, { ...where, branchId: await narrowTo(q, cfg, branch, user.branchOnly), limit: n }));
}
