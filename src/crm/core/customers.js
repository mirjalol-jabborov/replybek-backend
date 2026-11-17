// Customers: one list for the whole business. Bookings and orders point at them, and make new
// ones through here, so a customer is checked the same way wherever they come from.
import { z } from "zod";
import { notFound } from "../../core/http.js";
import { read, write, wall, isUuid, insertRow, updateRow } from "../db.js";
import { bad, conflict } from "../errors.js";
import { someKey } from "../shapes.js";
import { modules, customerUses } from "../modules.js";
import { cleanFields, hasId, normalPhone, same } from "../shared/index.js";

/** The columns of a customer as the app reads it. `tz`: the parameter holding the workspace's time zone ("$2"). */
export const customerCols = (tz) => `id, name, phone, telegram, instagram, source, tags, note, fields, ${wall("created_at", tz)} AS "createdAt"`;
const MAP = { json: ["fields"], touch: true };

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
export const customerUpdateSchema = z.object(shape).partial().strict().refine(someKey, "Nothing to change.");

/** Every customer of the workspace, oldest first. */
export async function listCustomers(q, cfg) {
  const { rows } = await q(`SELECT ${customerCols("$2")} FROM crm_customers WHERE workspace_id = $1 ORDER BY created_at, id`, [cfg.workspaceId, cfg.timezone]);
  return rows;
}

/** One customer of this workspace, or null. Another workspace's id reads like one that doesn't exist. */
export async function findCustomer(q, cfg, id, lock = "") {
  if (!isUuid(id)) return null;
  return (await q(`SELECT ${customerCols("$3")} FROM crm_customers WHERE workspace_id = $1 AND id = $2 ${lock}`, [cfg.workspaceId, id, cfg.timezone])).rows[0] || null;
}
async function getCustomer(q, cfg, id, lock) {
  const found = await findCustomer(q, cfg, id, lock);
  if (!found) throw notFound("Customer not found");
  return found;
}

/** Whether this workspace has the customer a booking or an order names. */
export async function customerExists(q, cfg, id) {
  return Boolean((await q("SELECT 1 FROM crm_customers WHERE workspace_id = $1 AND id = $2", [cfg.workspaceId, id])).rows[0]);
}

/**
 * Where something came from: one of the workspace's sources. What it already has (`kept`) stays
 * valid: a source that was removed since, or "ai" for what the AI agent brought in. `what` names
 * the thing for the message: "customer", "booking", "order".
 */
export function needSource(cfg, source, kept, what) {
  if (source && source !== kept && !hasId(cfg.data.sources, source)) throw bad(`Choose where the ${what} came from.`, "bad_source");
}

/** How many customers came from each of these sources: { [sourceId]: n }. */
export async function sourceUses(c, workspaceId, ids) {
  if (!ids.length) return {};
  const { rows } = await c.query("SELECT source, count(*)::int AS n FROM crm_customers WHERE workspace_id = $1 AND source = ANY($2::text[]) GROUP BY source", [workspaceId, ids]);
  return Object.fromEntries(rows.map((r) => [r.source, r.n]));
}

/**
 * Checks what was sent against the workspace's lists and returns the columns to store.
 * `stored`: the customer as it is now (an edit).
 */
export async function cleanCustomer(q, cfg, sent, stored) {
  const out = {};
  for (const key of ["name", "telegram", "instagram", "note"]) if (sent[key] !== undefined) out[key] = sent[key];
  if (sent.phone !== undefined) {
    // A customer may have no phone (someone who only writes on Instagram). A phone that is given must be a real one.
    out.phone = sent.phone === "" ? "" : normalPhone(sent.phone);
    if (out.phone === null) throw bad("Write the number like +998 90 123 45 67.", "bad_phone");
    if (out.phone) {
      // `phone <> ''` lets Postgres use the unique index on phone, which leaves empty numbers out.
      const twin = (await q("SELECT id, name FROM crm_customers WHERE workspace_id = $1 AND phone = $2 AND phone <> '' AND id IS DISTINCT FROM $3", [cfg.workspaceId, out.phone, stored?.id || null])).rows[0];
      if (twin) throw conflict(`${twin.name} already has this number.`, "phone_taken", { customerId: twin.id, customerName: twin.name });
    }
  }
  if (sent.source !== undefined) {
    needSource(cfg, sent.source, stored?.source, "customer");
    out.source = sent.source;
  }
  if (sent.tags !== undefined) {
    out.tags = [...new Set(sent.tags)];
    if (out.tags.some((t) => !hasId(cfg.data.tags, t))) throw bad("One of the tags no longer exists.", "bad_tag");
  }
  if (sent.fields !== undefined) {
    const { values, errors } = cleanFields(cfg.data.fields.customer, sent.fields, stored?.fields);
    if (Object.keys(errors).length) throw bad("One of the customer's fields has a value that doesn't fit it.", "bad_fields", { fields: errors });
    out.fields = values;
  }
  return out;
}

/** Stores a customer that cleanCustomer() passed. Returns the row as the app reads it. */
export async function insertCustomer(c, cfg, values) {
  return (await insertRow(c, cfg, "crm_customers", MAP, customerCols, values))[0];
}

export function createCustomer(workspaceId, input) {
  return write(workspaceId, async (c, cfg, q) => {
    const row = await insertCustomer(c, cfg, await cleanCustomer(q, cfg, input));
    return { changes: { set: { customers: [row] } }, id: row.id };
  });
}

export function updateCustomer(workspaceId, id, input) {
  return write(workspaceId, async (c, cfg, q) => {
    const stored = await getCustomer(q, cfg, id, "FOR UPDATE");
    const v = await cleanCustomer(q, cfg, input, stored);
    // Only what really differs is written, so saving a form nobody touched changes nothing and wakes nobody.
    const changed = Object.fromEntries(Object.entries(v).filter(([k, x]) => !same(x, stored[k])));
    if (!someKey(changed)) return { changes: { set: { customers: [stored] } } };
    return { changes: { set: { customers: await updateRow(c, cfg, "crm_customers", MAP, customerCols, id, changed) } } };
  });
}

/** Deletes a customer nothing points at. One with bookings or orders stays: those would lose their customer. */
export function deleteCustomer(workspaceId, id) {
  return write(workspaceId, async (c, cfg, q) => {
    const stored = await getCustomer(q, cfg, id, "FOR UPDATE");
    const uses = await customerUses(c, workspaceId, id);
    if (someKey(uses)) throw conflict(`${stored.name} has bookings or orders, so they can't be deleted.`, "customer_in_use", { uses });
    await c.query("DELETE FROM crm_customers WHERE workspace_id = $1 AND id = $2", [workspaceId, id]);
    return { changes: { del: { customers: [id] } } };
  });
}

/** A customer with everything the modules keep about them: { customer, appointments: [], orders: [] }. */
export function customerHistory(ctx, id) {
  return read(ctx.workspace.id, async (q, cfg) => {
    const inside = { ...ctx, q, cfg };
    const out = { customer: await getCustomer(q, cfg, id) };
    for (const m of modules) if (m.customerHistory) Object.assign(out, await m.customerHistory(inside, id));
    return out;
  });
}
