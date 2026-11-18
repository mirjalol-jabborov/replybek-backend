// When money counts, as SQL pieces the income and customer reports share, so both add up the
// same way. Every query that uses them binds:
//   $1 workspace, $2 its time zone, $3 the first day, $4 the day after the last, $5 branch or null,
//   $6 the ids of the booking steps of kind `done`.
//
// - A booking counts its price once it is finished (a `done` step) and paid, on the day of the visit.
// - An order counts once it was handed over (its goods left the shelf: the ledger's `sale` lines,
//   written when it entered its `done` step). Each payment for it counts on the day it came in, or
//   on the hand-over day when it came in before (a part paid ahead counts when the order is handed
//   over, so a past day never changes later). Money for an order never handed over is not income.
// - A refund (a minus payment) of a handed-over order is its own line, on the day it was given back
//   (or the hand-over day, if earlier). So orders less refunds is what the order panels say was paid.

import { ONE, EACH } from "../db.js";

/** The span as instants, for columns that are real moments (payments, the ledger). */
export const FROM = "($3::date::timestamp AT TIME ZONE $2)";
export const END = "($4::date::timestamp AT TIME ZONE $2)";


/** `handed`: (order_id, at, customer_id, branch_id) for every order that may have money in the span, with when it was handed over. */
export const HANDED = `
  maybe AS (
    SELECT m.order_id FROM crm_stock_moves m
     WHERE m.workspace_id = $1 AND m.type = 'sale' AND m.order_id IS NOT NULL AND m.at >= ${FROM} AND m.at < ${END}
    UNION
    SELECT p.order_id FROM crm_payments p WHERE p.workspace_id = $1 AND p.at >= ${FROM} AND p.at < ${END}
  ),
  handed AS (
    SELECT x.order_id, s.at, o.customer_id, o.branch_id FROM maybe x
     CROSS JOIN LATERAL (SELECT min(m.at) AS at FROM crm_stock_moves m
                          WHERE m.workspace_id = $1 AND m.order_id = x.order_id AND m.order_id IS NOT NULL AND m.type = 'sale') s
     CROSS JOIN LATERAL (SELECT o.customer_id, o.branch_id FROM crm_orders o WHERE o.workspace_id = $1 AND o.id = x.order_id ${ONE}) o
     WHERE s.at IS NOT NULL
  )`;

/** `takings`: (at as wall clock, customer_id, what: booking | order | refund, amount > 0) inside the span. Needs HANDED before it. */
export const TAKINGS = `
  takings AS (
    SELECT a.start_at AS at, a.customer_id, 'booking' AS what, a.price AS amount
      FROM crm_appointments a
     WHERE a.workspace_id = $1 AND a.start_at >= $3::date AND a.start_at < $4::date
       AND a.paid AND a.status = ANY($6::text[]) AND ($5::uuid IS NULL OR a.branch_id = $5)
    UNION ALL
    SELECT greatest(p.at, h.at) AT TIME ZONE $2, h.customer_id, CASE WHEN p.amount > 0 THEN 'order' ELSE 'refund' END, abs(p.amount)
      FROM handed h
     CROSS JOIN LATERAL (SELECT p.at, p.amount FROM crm_payments p WHERE p.workspace_id = $1 AND p.order_id = h.order_id ${EACH}) p
     WHERE greatest(p.at, h.at) >= ${FROM} AND greatest(p.at, h.at) < ${END} AND ($5::uuid IS NULL OR h.branch_id = $5)
  )`;

/** The parameters $1 … $6 of a query built on these pieces. */
export const moneyParams = (cfg, p, doneSteps) => [cfg.workspaceId, cfg.timezone, p.from, p.end, p.branch, doneSteps];
