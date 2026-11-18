// Bookings of a span of days (by the day of the visit) as a sheet, for an export.
import { wall, ONE } from "../db.js";
import { header, yesNo, L } from "./words.js";
import { listName, fieldCell } from "./cells.js";

const COLUMNS = ["start", "minutes", "customer", "phone", "specialist", "services", "step", "price", "paid", "source", "note"];

/** `p`: { from, end (the day after the last), branch | null }. */
export async function bookingsSheet(q, cfg, p, lang) {
  const defs = cfg.data.fields.appointment || [];
  const { rows } = await q(
    `SELECT a.id, to_char(a.start_at, 'YYYY-MM-DD HH24:MI') AS start, a.duration, a.price::float8 AS price, a.status, a.paid, a.source, a.note, a.fields,
            ${wall("a.created_at", "$5")} AS created, c.name AS customer, c.phone, s.name AS staff,
            (SELECT array_agg(x.name ORDER BY u.n) FROM unnest(a.service_ids) WITH ORDINALITY AS u(id, n) JOIN crm_services x ON x.workspace_id = $1 AND x.id = u.id) AS services
       FROM crm_appointments a
      CROSS JOIN LATERAL (SELECT c.name, c.phone FROM crm_customers c WHERE c.workspace_id = $1 AND c.id = a.customer_id ${ONE}) c
       JOIN crm_staff s ON s.workspace_id = a.workspace_id AND s.id = a.staff_id
      WHERE a.workspace_id = $1 AND a.start_at >= $2::date AND a.start_at < $3::date AND ($4::uuid IS NULL OR a.branch_id = $4)
      ORDER BY a.start_at, a.id`,
    [cfg.workspaceId, p.from, p.end, p.branch, cfg.timezone]
  );
  return {
    header: [...COLUMNS.map((k) => header(k, lang)), ...defs.map((d) => L(d.name, lang)), header("created", lang), header("id", lang)],
    rows: rows.map((a) => [
      a.start,
      a.duration,
      a.customer,
      a.phone,
      a.staff,
      (a.services || []).map((n) => L(n, lang)).join(", "),
      listName(cfg.data.apptStages, a.status, lang),
      a.price,
      yesNo(a.paid, lang),
      listName(cfg.data.sources, a.source, lang),
      L(a.note, lang),
      ...defs.map((d) => fieldCell(d, a.fields[d.id], lang)),
      a.created.replace("T", " "),
      a.id,
    ]),
  };
}
