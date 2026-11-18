// Moving an order between the workspace's own steps. What a step does to stock comes from its kind
// (open, reserved, done, cancelled), never from its id or name: planMove() in ../shared/store.js
// decides, this file locks the order and its stock and writes exactly what the plan says.
import { z } from "zod";
import { write } from "../db.js";
import { refusal } from "../errors.js";
import { firstOf } from "../shared/index.js";
import { K, planMove } from "../shared/store.js";
import { addPayment, historyLine, lockOrder, storeChanges } from "./rows.js";
import { lockStock, postMoves, reviveReturned } from "./stock.js";

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
  if (!plan.ok) throw refusal(plan.missing);
  const moveIds = await postMoves(c, cfg, user, plan.movements, { orderId: order.id, branchId: order.branchId, note: plan.change === "returned" ? text || "" : "" });
  if (plan.change === "returned") await reviveReturned(c, cfg, variantIds);
  if (plan.history) {
    // The move, then what handing over took, as a payment taken by hand says it.
    const lines = [plan.history, plan.paid].filter(Boolean).map(({ text: what, ...about }) => historyLine(cfg, user, what, about));
    await c.query("UPDATE crm_orders SET status = $3, returned = $4, history = history || $5::jsonb, updated_at = now() WHERE workspace_id = $1 AND id = $2", [
      cfg.workspaceId,
      order.id,
      plan.order.status,
      Boolean(plan.order.returned),
      JSON.stringify(lines),
    ]);
  }
  if (plan.pay > 0) await addPayment(c, cfg, user, order.id, plan.pay, plan.paid.method);
  return { variantIds: plan.movements.length ? variantIds : [], moveIds, change: plan.change };
}

/** Moves a locked order and answers with what changed. */
async function moveAndAnswer(c, cfg, q, user, order, to, text) {
  const { change, ...moved } = await applyMove(c, cfg, user, order, to, text);
  return { changes: await storeChanges(q, cfg, { orderId: order.id, ...moved, branchId: user?.branchOnly }), id: order.id, change };
}

/** Moves an order to another step. A finished order moves only to the cancelled step: that is a return. */
export function moveOrder(workspace, user, id, { to, note: text }) {
  return write(workspace.id, async (c, cfg, q) => moveAndAnswer(c, cfg, q, user, await lockOrder(q, cfg, id, user?.branchOnly), to, text));
}

/** Calls an order off: to the workspace's cancelled step. A finished order's goods come back. */
export function cancelOrder(workspace, user, id, { note: text } = {}) {
  return write(workspace.id, async (c, cfg, q) => moveAndAnswer(c, cfg, q, user, await lockOrder(q, cfg, id, user?.branchOnly), cancelledStep(cfg), text));
}
