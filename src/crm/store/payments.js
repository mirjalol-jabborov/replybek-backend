// Money for an order: payments in (all that is owed, or a part) and refunds out (a minus
// payment, for admins). `order.paid` is true when nothing is owed any more; the sums are
// totals() in ../shared/store.js, so the app and the server add up the same way.
import { z } from "zod";
import { HttpError } from "../../lib/http.js";
import { write } from "../db.js";
import { hasId } from "../shared/index.js";
import { K, kindIn } from "../shared/store.js";
import { addPayment, historyLine, lockOrder, orderChanges } from "./rows.js";
import { applyMove, cancelledStep } from "./steps.js";

const amount = z.number().int().min(1).max(1e12).optional(); // whole soʻm; all of it when not given
const method = z.string().trim().max(40).optional(); // the order's payment method when not given
const note = z.string().trim().max(500).optional();
export const paySchema = z.object({ amount, method, note }).strict();
export const refundSchema = z.object({ amount, method, note, returnGoods: z.boolean().optional() }).strict();

const conflict = (message, code, extra) => new HttpError(409, message, { code, ...extra });

/** The payment method to record: the one named, else the order's. One that isn't in the list is refused. */
function methodOf(cfg, order, named) {
  if (named && named !== order.payment && !hasId(cfg.data.paymentMethods, named)) throw new HttpError(400, "Choose a payment method from the list.", { code: "bad_payment" });
  return named || order.payment;
}

const addHistory = (c, cfg, orderId, line) =>
  c.query("UPDATE crm_orders SET history = history || $3::jsonb, updated_at = now() WHERE workspace_id = $1 AND id = $2", [cfg.workspaceId, orderId, JSON.stringify([line])]);

/** Money came in: all that is owed, or a part of it. Never more than is owed, never for a cancelled order. */
export function payOrder(workspace, user, id, input) {
  return write(workspace.id, async (c, cfg) => {
    const order = await lockOrder(c, cfg, id);
    if (kindIn(cfg.data.orderStages, order.status) === K.cancelled) throw conflict("This order is cancelled.", "order_cancelled");
    const { balance } = order.totals;
    if (balance <= 0) throw conflict("This order is already paid.", "already_paid");
    const sum = input.amount ?? balance;
    if (sum > balance) throw conflict("That is more than is still owed.", "over_balance", { balance });
    const how = methodOf(cfg, order, input.method);
    await addPayment(c, cfg, user, order.id, sum, how, input.note || "");
    await addHistory(c, cfg, order.id, historyLine(cfg, user, sum === balance ? "paid" : "part_paid", { amount: sum, method: how }));
    return orderChanges(c, cfg, order.id);
  });
}

/**
 * Money goes back to the customer: a payment with a minus, never more than was paid. With
 * `returnGoods`, a finished order's goods also come back to the shelf and the order is closed
 * as returned, in the same transaction.
 */
export function refundOrder(workspace, user, id, input) {
  return write(workspace.id, async (c, cfg) => {
    const order = await lockOrder(c, cfg, id);
    const { paid } = order.totals;
    if (paid <= 0) throw conflict("Nothing was paid for this order.", "nothing_paid");
    const sum = input.amount ?? paid;
    if (sum > paid) throw conflict("That is more than was paid.", "over_paid", { paid });
    const how = methodOf(cfg, order, input.method);
    let moved = {};
    if (input.returnGoods) {
      if (kindIn(cfg.data.orderStages, order.status) !== K.done || order.returned) throw conflict("Only a finished order's goods can come back.", "not_done");
      moved = await applyMove(c, cfg, user, order, cancelledStep(cfg), input.note);
    }
    await addPayment(c, cfg, user, order.id, -sum, how, input.note || "");
    await addHistory(c, cfg, order.id, historyLine(cfg, user, "refunded", { amount: sum, method: how, ...(input.note ? { note: input.note } : {}) }));
    return orderChanges(c, cfg, order.id, moved);
  });
}
