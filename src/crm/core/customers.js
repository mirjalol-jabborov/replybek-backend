// Customers: one list for the whole business. Bookings and orders point at them.
import { z } from "zod";
import { HttpError, notFound } from "../../lib/http.js";
import { read, write, wall } from "../db.js";
import { modules, customerUses } from "../modules.js";
import { cleanFields, hasId, normalPhone } from "../shared/index.js";

/** The columns of a customer as the app reads it. `tz`: the parameter holding the workspace's time zone ("$2"). */
export const customerCols = (tz) => `id, name, phone, telegram, instagram, source, tags, note, fields, ${wall("created_at", tz)} AS "createdAt"`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const short = (max) => z.string().trim().max(max);
const shape = {
  name: z.string().trim().min(1, "Add the customer's name.").max(120),
  phone: short(40),
  telegram: short(64),
  instagram: short(64),
  source: short(40),
  tags: z.array(z.string().max(40)).max(50),
  note: short(2000),
  fields: z.record(z.unknown()),
};
// A new customer needs a name; an edit changes only what it sends.
export const customerCreateSchema = z.object(shape).partial().required({ name: true }).strict();
export const customerUpdateSchema = z.object(shape).partial().strict().refine((v) => Object.keys(v).length > 0, "Nothing to change.");

/** Every customer of the workspace, oldest first. */
export async function listCustomers(q, cfg) {
  const { rows } = await q(`SELECT ${customerCols("$2")} FROM crm_customers WHERE workspace_id = $1 ORDER BY created_at, id`, [cfg.workspaceId, cfg.timezone]);
  return rows;
}

/** One customer of this workspace. Another workspace's id reads as "not found", like an id that doesn't exist. */
async function getCustomer(q, cfg, id, lock = "") {
  const { rows } = UUID.test(id) ? await q(`SELECT ${customerCols("$3")} FROM crm_customers WHERE workspace_id = $1 AND id = $2 ${lock}`, [cfg.workspaceId, id, cfg.timezone]) : { rows: [] };
  if (!rows[0]) throw notFound("Customer not found");
  return rows[0];
}

/** Whether two stored values (text, a list of tags, a fields object) are the same. */
const same = (a, b) => (a && typeof a === "object" && b && typeof b === "object" ? Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => same(a[k], b[k])) : a === b);

/** How many customers came from each of these sources: { [sourceId]: n }. */
export async function sourceUses(c, workspaceId, ids) {
  if (!ids.length) return {};
  const { rows } = await c.query("SELECT source, count(*)::int AS n FROM crm_customers WHERE workspace_id = $1 AND source = ANY($2::text[]) GROUP BY source", [workspaceId, ids]);
  return Object.fromEntries(rows.map((r) => [r.source, r.n]));
}

/**
 * Checks what was sent against the workspace's lists and returns the columns to store.
 * `stored`: the customer as it is now (an edit). What it already has stays valid: a source that
 * was removed since, or "ai" for someone the AI agent brought in.
 */
async function clean(c, cfg, sent, stored) {
  const out = {};
  for (const key of ["name", "telegram", "instagram", "note"]) if (sent[key] !== undefined) out[key] = sent[key];
  if (sent.phone !== undefined) {
    // A customer may have no phone (someone who only writes on Instagram). A phone that is given must be a real one.
    out.phone = sent.phone === "" ? "" : normalPhone(sent.phone);
    if (out.phone === null) throw new HttpError(400, "Write the number like +998 90 123 45 67.", { code: "bad_phone" });
    if (out.phone) {
      // `phone <> ''` lets Postgres use the unique index on phone, which leaves empty numbers out.
      const twin = (await c.query("SELECT id, name FROM crm_customers WHERE workspace_id = $1 AND phone = $2 AND phone <> '' AND id IS DISTINCT FROM $3", [cfg.workspaceId, out.phone, stored?.id || null])).rows[0];
      if (twin) throw new HttpError(409, `${twin.name} already has this number.`, { code: "phone_taken", customerId: twin.id, customerName: twin.name });
    }
  }
  if (sent.source !== undefined) {
    if (sent.source && sent.source !== stored?.source && !hasId(cfg.data.sources, sent.source)) throw new HttpError(400, "Choose where the customer came from.", { code: "bad_source" });
    out.source = sent.source;
  }
  if (sent.tags !== undefined) {
    out.tags = [...new Set(sent.tags)];
    if (out.tags.some((t) => !hasId(cfg.data.tags, t))) throw new HttpError(400, "One of the tags no longer exists.", { code: "bad_tag" });
  }
  if (sent.fields !== undefined) {
    const { values, errors } = cleanFields(cfg.data.fields.customer, sent.fields, stored?.fields);
    if (Object.keys(errors).length) throw new HttpError(400, "One of the customer's fields has a value that doesn't fit it.", { code: "bad_fields", fields: errors });
    out.fields = JSON.stringify(values);
  }
  return out;
}

export function createCustomer(workspaceId, input) {
  return write(workspaceId, async (c, cfg) => {
    const v = await clean(c, cfg, input);
    const cols = Object.keys(v);
    const { rows } = await c.query(
      `INSERT INTO crm_customers (workspace_id, ${cols.join(", ")}) VALUES ($1, ${cols.map((_, i) => `$${i + 3}`).join(", ")}) RETURNING ${customerCols("$2")}`,
      [workspaceId, cfg.timezone, ...cols.map((k) => v[k])]
    );
    return { changes: { set: { customers: rows } }, id: rows[0].id };
  });
}

export function updateCustomer(workspaceId, id, input) {
  return write(workspaceId, async (c, cfg) => {
    const stored = await getCustomer((text, params) => c.query(text, params), cfg, id, "FOR UPDATE");
    const v = await clean(c, cfg, input, stored);
    // Only what really differs is written, so saving a form nobody touched changes nothing and wakes nobody.
    const cols = Object.keys(v).filter((k) => !same(k === "fields" ? JSON.parse(v[k]) : v[k], stored[k]));
    if (!cols.length) return { changes: { set: { customers: [stored] } } };
    const { rows } = await c.query(
      `UPDATE crm_customers SET ${cols.map((k, i) => `${k} = $${i + 4}`).join(", ")}, updated_at = now() WHERE workspace_id = $1 AND id = $2 RETURNING ${customerCols("$3")}`,
      [workspaceId, id, cfg.timezone, ...cols.map((k) => v[k])]
    );
    return { changes: { set: { customers: rows } } };
  });
}

/** Deletes a customer nothing points at. One with bookings or orders stays: those would lose their customer. */
export function deleteCustomer(workspaceId, id) {
  return write(workspaceId, async (c, cfg) => {
    const stored = await getCustomer((text, params) => c.query(text, params), cfg, id, "FOR UPDATE");
    const uses = await customerUses(c, workspaceId, id);
    if (Object.keys(uses).length) throw new HttpError(409, `${stored.name} has bookings or orders, so they can't be deleted.`, { code: "customer_in_use", uses });
    await c.query("DELETE FROM crm_customers WHERE workspace_id = $1 AND id = $2", [workspaceId, id]);
    return { changes: { del: { customers: [id] } } };
  });
}

/** A customer with everything the modules keep about them: { customer, appointments: [], orders: [] }. */
export function customerHistory(ctx, id) {
  return read(async (q) => {
    const inside = { ...ctx, q };
    const out = { customer: await getCustomer(q, ctx.cfg, id) };
    for (const m of modules) if (m.customerHistory) Object.assign(out, await m.customerHistory(inside, id));
    return out;
  });
}
