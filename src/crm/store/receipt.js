// The printed receipt of an order: everything a slip needs, read on one unchanging picture.
import { notFound } from "../../core/http.js";
import { read, isUuid } from "../db.js";
import { findCustomer } from "../core/customers.js";
import { branchOf } from "../core/branches.js";
import { lineTotal, optionsText } from "../shared/store.js";
import { listOrders } from "./rows.js";

/**
 * What a printed receipt needs, read in one picture: the business, the order's number and date,
 * the customer, each line with its name, the discounts, the fee, the total, what was paid and what
 * is owed. Names from the workspace's lists come as stored ({en, ru, uz} or text): the app shows them.
 */
export function receipt(ctx, id) {
  const { workspace } = ctx;
  return read(workspace.id, async (q, cfg) => {
    const [order] = isUuid(id) ? await listOrders(q, cfg, { ids: [id] }) : [];
    if (!order) throw notFound("Order not found");
    const customer = await findCustomer(q, cfg, { id: order.customerId });
    const branch = await branchOf(q, cfg, order.branchId);
    const { rows: goods } = await q(
      `SELECT v.id, p.name, p.unit, p.options, v.option_values AS values, v.sku FROM crm_variants v JOIN crm_products p ON p.workspace_id = v.workspace_id AND p.id = v.product_id
        WHERE v.workspace_id = $1 AND v.id = ANY($2::uuid[])`,
      [cfg.workspaceId, order.lines.map((l) => l.variantId)]
    );
    const named = (list, listItemId) => cfg.data[list].find((x) => x.id === listItemId)?.name ?? "";
    return {
      business: { name: workspace.name, branch: branch?.name || "", address: branch?.address || "" },
      id: order.id,
      number: order.number,
      date: order.createdAt,
      printedAt: cfg.now,
      status: order.status,
      statusName: named("orderStages", order.status),
      ...(order.returned ? { returned: true } : {}),
      customer: { name: customer?.name || "", phone: customer?.phone || "" },
      lines: order.lines.map((l) => {
        const g = goods.find((x) => x.id === l.variantId);
        return {
          productId: l.productId,
          variantId: l.variantId,
          name: g.name,
          variant: optionsText(g.options, g.values),
          sku: g.sku,
          unit: g.unit,
          unitName: named("units", g.unit),
          qty: l.qty,
          price: l.price,
          discount: l.discount,
          total: lineTotal(l),
        };
      }),
      delivery: { ...order.delivery, name: named("deliveryMethods", order.delivery.type) },
      payment: order.payment,
      paymentName: named("paymentMethods", order.payment),
      payments: order.payments.map((p) => ({ ...p, methodName: named("paymentMethods", p.method) })),
      totals: order.totals,
      paid: order.paid,
      note: order.note,
    };
  });
}
