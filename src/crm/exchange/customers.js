// Customers in a spreadsheet: the export, and the plan and write of an import.
//
// A row is matched to a customer by the ID column (an export carries it), else by phone; a row
// that matches nobody is a new customer. Every value is checked as the customer form checks it
// (Core's cleanCustomer, normalPhone): only the lookups by phone are done once for the whole file
// instead of once per row.
import { conflict } from "../errors.js";
import { isUuid } from "../db.js";
import { normalPhone, same } from "../shared/index.js";
import { customerCols, customerCreateSchema, cleanCustomer, listCustomers, findCustomers } from "../core/customers.js";
import { HEADERS, header, spellings, L } from "./words.js";
import { findInList, findAllInList, listName, readField, fieldCell, shapeReason } from "./cells.js";

const BASE = ["name", "phone", "telegram", "instagram", "source", "tags", "note"];
const field = (def) => `field:${def.id}`;

/** The columns an import knows. "added" is read only. */
export const customerColumns = (cfg) => [
  ...["id", ...BASE, "added"].map((key) => ({ key, words: HEADERS[key] })),
  ...(cfg.data.fields.customer || []).map((def) => ({ key: field(def), words: spellings(def.name) })),
];

/** Every customer as a sheet, oldest first. */
export async function customersSheet(q, cfg, lang) {
  const defs = cfg.data.fields.customer || [];
  const rows = (await listCustomers(q, cfg)).map((c) => [
    c.name,
    c.phone,
    c.telegram,
    c.instagram,
    listName(cfg.data.sources, c.source, lang),
    c.tags.map((t) => listName(cfg.data.tags, t, lang)).join(", "),
    c.note,
    ...defs.map((d) => fieldCell(d, c.fields[d.id], lang)),
    c.createdAt.replace("T", " "),
    c.id,
  ]);
  return { header: [...BASE.map((k) => header(k, lang)), ...defs.map((d) => L(d.name, lang)), header("added", lang), header("id", lang)], rows };
}

const shapeCheck = customerCreateSchema.partial();

/** One row's cells as the customer form would send them, or { skip: reason }. */
function sentOf(cfg, v) {
  const sent = {};
  for (const key of ["name", "phone", "telegram", "instagram", "note"]) if (key in v) sent[key] = v[key];
  if ("source" in v) {
    sent.source = findInList(cfg.data.sources, v.source);
    if (sent.source === undefined) return { skip: { code: "bad_source", value: v.source } };
  }
  if ("tags" in v) {
    const { ids, bad } = findAllInList(cfg.data.tags, v.tags);
    if (bad) return { skip: { code: "bad_tag", value: bad } };
    sent.tags = ids;
  }
  const fields = {};
  for (const def of cfg.data.fields.customer || []) if (field(def) in v) fields[def.id] = readField(def, v[field(def)]);
  if (Object.keys(fields).length) sent.fields = fields;
  return { sent };
}

/**
 * What importing this table would do, against the customers as they are now:
 * { add: [{ row, values }], update: [{ row, id, name, values (only what changes) }], unchanged: [row], skip: [{ row, code, ... }] }.
 * Reads the customers the file names in one query.
 */
export async function planCustomers(q, cfg, table) {
  const ids = [...new Set(table.rows.map((r) => r.values.id).filter(isUuid))];
  const phones = [...new Set(table.rows.map((r) => normalPhone(r.values.phone)).filter(Boolean))];
  const { rows: known } = await q(
    `SELECT ${customerCols("$2")} FROM crm_customers WHERE workspace_id = $1 AND (id = ANY($3::uuid[]) OR (phone = ANY($4::text[]) AND phone <> ''))`,
    [cfg.workspaceId, cfg.timezone, ids, phones]
  );
  const byId = new Map(known.map((c) => [c.id, c]));
  const byPhone = new Map(known.filter((c) => c.phone).map((c) => [c.phone, c]));
  const plan = { add: [], update: [], unchanged: [], skip: [] };
  const seenId = new Map();
  const seenPhone = new Map();

  for (const { n, values: v } of table.rows) {
    const skip = (reason) => plan.skip.push({ row: n, ...reason });
    const { sent, skip: why } = sentOf(cfg, v);
    if (why) {
      skip(why);
      continue;
    }
    let stored = null;
    if (v.id) {
      stored = byId.get(v.id);
      if (!stored) {
        skip({ code: "unknown_id" });
        continue;
      }
    }
    const phone = sent.phone === undefined ? undefined : sent.phone.trim() === "" ? "" : normalPhone(sent.phone);
    if (phone === null) {
      skip({ code: "bad_phone" });
      continue;
    }
    if (!stored && phone) stored = byPhone.get(phone) || null;
    // A new customer needs what the form needs (a name); a known one, only what the file changes.
    const shape = (stored ? shapeCheck : customerCreateSchema).safeParse(sent);
    if (!shape.success) {
      skip(shapeReason(shape.error));
      continue;
    }
    const twin = (stored && seenId.get(stored.id)) || (phone && seenPhone.get(phone));
    if (twin) {
      skip({ code: "duplicate", first: twin });
      continue;
    }
    const holder = phone ? byPhone.get(phone) : null;
    if (holder && holder.id !== stored?.id) {
      skip({ code: "phone_taken", customerId: holder.id });
      continue;
    }
    let clean;
    try {
      // Without the phone, cleanCustomer asks the database nothing: the phone was checked above, for the whole file at once.
      const { phone: _, ...rest } = shape.data;
      clean = await cleanCustomer(q, cfg, rest, stored);
    } catch (e) {
      if (!e.extra?.code) throw e;
      skip({ code: e.extra.code, ...(e.extra.fields ? { fields: e.extra.fields } : {}) });
      continue;
    }
    if (phone !== undefined) clean.phone = phone;
    if (stored) seenId.set(stored.id, n);
    if (phone) seenPhone.set(phone, n);
    if (!stored) {
      plan.add.push({ row: n, values: { name: "", phone: "", telegram: "", instagram: "", source: "", tags: [], note: "", fields: {}, ...clean } });
      continue;
    }
    const changed = Object.fromEntries(Object.entries(clean).filter(([k, x]) => !same(x, stored[k])));
    if (Object.keys(changed).length) plan.update.push({ row: n, id: stored.id, name: stored.name, values: changed });
    else plan.unchanged.push(n);
  }
  return plan;
}

const COLUMNS = "name text, phone text, telegram text, instagram text, source text, tags text[], note text, fields jsonb";

/** Writes a plan: every new customer in one statement, every change in another. Returns the rows as the app reads them. */
export async function applyCustomers(c, cfg, q, plan) {
  try {
    const { rows: added } = plan.add.length
      ? await c.query(
          `INSERT INTO crm_customers (workspace_id, name, phone, telegram, instagram, source, tags, note, fields)
           SELECT $1, x.name, x.phone, x.telegram, x.instagram, x.source, x.tags, x.note, x.fields FROM jsonb_to_recordset($2::jsonb) AS x(${COLUMNS})
           RETURNING id`,
          [cfg.workspaceId, JSON.stringify(plan.add.map((a) => a.values))]
        )
      : { rows: [] };
    if (plan.update.length) {
      await c.query(
        `UPDATE crm_customers c SET name = COALESCE(x.name, c.name), phone = COALESCE(x.phone, c.phone), telegram = COALESCE(x.telegram, c.telegram),
                instagram = COALESCE(x.instagram, c.instagram), source = COALESCE(x.source, c.source), tags = COALESCE(x.tags, c.tags),
                note = COALESCE(x.note, c.note), fields = COALESCE(x.fields, c.fields), updated_at = now()
           FROM jsonb_to_recordset($2::jsonb) AS x(id uuid, ${COLUMNS})
          WHERE c.workspace_id = $1 AND c.id = x.id`,
        [cfg.workspaceId, JSON.stringify(plan.update.map((u) => ({ id: u.id, ...u.values })))]
      );
    }
    const rows = await findCustomers(q, cfg, [...added.map((r) => r.id), ...plan.update.map((u) => u.id)]);
    return { changes: rows.length ? { set: { customers: rows } } : {}, added: added.length, updated: plan.update.length };
  } catch (e) {
    // The plan was made under the same lock, so a phone that is taken can't happen; if it does, nothing is saved.
    if (e.code === "23505") throw conflict("A phone number in the file is taken. Check the file again.", "preview_stale");
    throw e;
  }
}
