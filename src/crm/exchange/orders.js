// Orders of a span of days (by the day they were made) as two sheets, for an export: the orders
// with their money (the shared totals(), so the sums are the ones the order panels show) and
// their lines.
import { wall, ONE } from "../db.js";
import { totals, lineTotal, optionsText } from "../shared/store.js";
import { header, yesNo, L } from "../shared/sheets.js";
import { listName, fieldCell } from "./cells.js";

const ORDER = ["number", "created", "customer", "phone", "step", "items", "subtotal", "discount", "fee", "total", "paid", "balance", "payment", "delivery", "deliveryDay", "address", "source", "note", "returned"];
const LINE = ["order", "product", "variant", "sku", "qty", "price", "discount", "total"];

/** "Tulips (Red)": a line's product with what was chosen. */
const item = (l) => (optionsText(l.options, l.variant) ? `${l.name} (${optionsText(l.options, l.variant)})` : l.name);

/** `p`: { from, end (the day after the last), branch | null }. → [orders sheet, lines sheet] without names. */
export async function ordersSheets(q, cfg, p, lang) {
  const defs = cfg.data.fields.order || [];
  const { rows } = await q(
    `WITH o AS (
       SELECT o.* FROM crm_orders o
        WHERE o.workspace_id = $1 AND o.created_at >= ($2::date::timestamp AT TIME ZONE $5) AND o.created_at < ($3::date::timestamp AT TIME ZONE $5)
          AND ($4::uuid IS NULL OR o.branch_id = $4)
     )
     SELECT o.id, o.number, o.status, o.delivery, o.payment, o.discount::float8 AS discount, o.source, o.note, o.fields, o.returned,
            ${wall("o.created_at", "$5")} AS created, c.name AS customer, c.phone,
            (SELECT json_agg(json_build_object('qty', l.qty, 'price', l.price::float8, 'discount', l.discount::float8, 'name', pr.name,
                                               'variant', v.option_values, 'options', pr.options, 'sku', v.sku) ORDER BY l.position, l.id)
               FROM crm_order_lines l JOIN crm_variants v ON v.workspace_id = l.workspace_id AND v.id = l.variant_id
               JOIN crm_products pr ON pr.workspace_id = v.workspace_id AND pr.id = v.product_id
              WHERE l.workspace_id = $1 AND l.order_id = o.id) AS lines,
            (SELECT json_agg(json_build_object('amount', p.amount::float8)) FROM crm_payments p WHERE p.workspace_id = $1 AND p.order_id = o.id) AS payments
       FROM o CROSS JOIN LATERAL (SELECT c.name, c.phone FROM crm_customers c WHERE c.workspace_id = $1 AND c.id = o.customer_id ${ONE}) c
      ORDER BY o.created_at, o.number`,
    [cfg.workspaceId, p.from, p.end, p.branch, cfg.timezone]
  );
  const orders = [];
  const lines = [];
  for (const o of rows) {
    const list = o.lines || [];
    const t = totals({ status: o.status, returned: o.returned, lines: list, discount: o.discount, delivery: o.delivery, payments: o.payments || [] }, cfg.data.orderStages);
    orders.push([
      Number(o.number),
      o.created.replace("T", " "),
      o.customer,
      o.phone,
      listName(cfg.data.orderStages, o.status, lang),
      list.map((l) => `${item(l)} x ${l.qty}`).join(", "),
      t.subtotal,
      t.discount,
      t.fee,
      t.total,
      t.paid,
      t.balance,
      listName(cfg.data.paymentMethods, o.payment, lang),
      listName(cfg.data.deliveryMethods, o.delivery?.type, lang),
      o.delivery?.date || "",
      o.delivery?.address || "",
      listName(cfg.data.sources, o.source, lang),
      o.note,
      o.returned ? yesNo(true, lang) : "",
      ...defs.map((d) => fieldCell(d, o.fields[d.id], lang)),
      o.id,
    ]);
    for (const l of list) lines.push([Number(o.number), l.name, optionsText(l.options, l.variant), l.sku, l.qty, l.price, l.discount, lineTotal(l)]);
  }
  return [
    { header: [...ORDER.map((k) => header(k, lang)), ...defs.map((d) => L(d.name, lang)), header("id", lang)], rows: orders },
    { header: LINE.map((k) => header(k, lang)), rows: lines },
  ];
}
