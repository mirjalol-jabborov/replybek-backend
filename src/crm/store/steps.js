// Moving an order between the workspace's own steps. What a step does to stock comes from its kind
// (open, reserved, done, cancelled), never from its id or name: planMove() in ../shared/store.js
// decides, this file locks the order and its stock and writes exactly what the plan says.
import { z } from "zod";
import { write } from "../db.js";
import { firstOf } from "../shared/index.js";
import { K, planMove } from "../shared/store.js";
import { addPayment, lockOrder, orderChanges } from "./rows.js";
import { lockStock, postMoves, refused, reviveReturned } from "./stock.js";

const note = z.string().trim().max(500).optional();
export const stepSchema = z.object({ to: z.string().trim().min(1).max(40), note }).strict();
export const cancelSchema = z.object({ note }).strict();

/** The workspace's cancelled step (there is always exactly one). */
export const cancelledStep = (cfg) => firstOf(cfg.data.orderStages, K.cancelled)?.id;

/**
 * Moves a locked order to a step and writes what the plan says: ledger lines, the step, the
 * history line and, when handing over settles the bill, the payment. Refused (422) with the
 * plan's reasons. Returns what moved: { variantIds, moveIds, change }.
 */
export async function applyMove(c, cfg, user, order, to, text) {
  const variantIds = order.lines.map((l) => l.variantId);
  // The variants are locked before their stock is read, so two orders can't both take the last one.
  const stock = await lockStock(c, cfg, variantIds, order.branchId);
  const plan = planMove({ stages: cfg.data.orderStages, fields: cfg.data.fields.order, order, stock }, to, { note: text });
  if (!plan.ok) throw refused(plan.missing);
  const moveIds = await postMoves(c, cfg, user, plan.movements, { orderId: order.id, branchId: order.branchId, note: plan.change === "returned" ? text || "" : "" });
  if (plan.change === "returned") await reviveReturned(c, cfg, variantIds);
  if (plan.history) {
    await c.query("UPDATE crm_orders SET status = $3, returned = $4, history = history || $5::jsonb, updated_at = now() WHERE workspace_id = $1 AND id = $2", [
      cfg.workspaceId,
      order.id,
      plan.order.status,
      Boolean(plan.order.returned),
      JSON.stringify([{ ...plan.history, at: cfg.now, by: user?.name || "" }]),
    ]);
  }
  if (plan.pay > 0) await addPayment(c, cfg, user, order.id, plan.pay, order.payment);
  return { variantIds: plan.movements.length ? variantIds : [], moveIds, change: plan.change };
}

/** Moves an order to another step. A finished order moves only to the cancelled step: that is a return. */
export function moveOrder(workspace, user, id, { to, note: text }) {
  return write(workspace.id, async (c, cfg) => {
    const order = await lockOrder(c, cfg, id);
    const moved = await applyMove(c, cfg, user, order, to, text);
    return { ...(await orderChanges(c, cfg, order.id, moved)), change: moved.change };
  });
}

/** Calls an order off: to the workspace's cancelled step. A finished order's goods come back. */
export function cancelOrder(workspace, user, id, { note: text } = {}) {
  return write(workspace.id, async (c, cfg) => {
    const order = await lockOrder(c, cfg, id);
    const moved = await applyMove(c, cfg, user, order, cancelledStep(cfg), text);
    return { ...(await orderChanges(c, cfg, order.id, moved)), change: moved.change };
  });
}
