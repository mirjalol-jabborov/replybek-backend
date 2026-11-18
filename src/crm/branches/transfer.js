// Moving goods from one branch to another. One action, one transaction: the Store's ledger gets a
// pair of `transfer` lines per variant, a minus where the goods leave and the same plus where they
// arrive, so the business's totals never change and each branch's number is its ledger added up.
// The variants are locked and the sending branch's stock read before the plan is made (as every
// Store write does), so two moves can't both send the last item.
import { z } from "zod";
import { write } from "../db.js";
import { bad, refusal } from "../errors.js";
import { uuid, label } from "../shapes.js";
import { planTransfer } from "../shared/branches.js";
import { target, hasTarget, resolveVariants, lockStock, postMoves, storeChanges } from "../store/index.js";
import { needBranch } from "./access.js";

export const transferSchema = z
  .object({
    fromBranchId: uuid,
    toBranchId: uuid,
    lines: z.array(z.object({ ...target, qty: z.number().int().min(1).max(1_000_000) }).strict().refine(hasTarget, "Say which product.")).min(1, "Add at least one product.").max(200),
    note: label(500).optional(),
  })
  .strict();

/**
 * Sends goods from one branch to another. Only what is free at the sending branch goes (held goods
 * belong to orders): 422 rules [transfer_short]. A closed branch can send its goods away but
 * receives none (409 branch_closed). A team member limited to one branch can't move goods out of it
 * or into it, since the other side is not theirs (403 other_branch).
 */
export function transferStock(workspace, user, { fromBranchId, toBranchId, lines, note = "" }) {
  return write(workspace.id, async (c, cfg, q) => {
    const from = await needBranch(q, cfg, user, fromBranchId);
    const to = await needBranch(q, cfg, user, toBranchId, { work: true });
    if (from === to) throw bad("Choose two different branches.", "same_branch");
    const ids = await resolveVariants(c, cfg, lines);
    const stock = await lockStock(c, cfg, ids, from);
    const plan = planTransfer(stock, lines.map((l, i) => ({ variantId: ids[i], qty: l.qty })));
    if (!plan.ok) throw refusal(plan.missing);
    const moves = plan.movements.map(({ side, ...m }) => (side === "from" ? { ...m, branchId: from, otherBranchId: to } : { ...m, branchId: to, otherBranchId: from }));
    const moveIds = await postMoves(c, cfg, user, moves, { note });
    return { changes: await storeChanges(q, cfg, { variantIds: ids, moveIds }) };
  });
}
