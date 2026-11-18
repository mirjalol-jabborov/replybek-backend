// Customers: one list for the whole business. Bookings and orders point at them, and make new
// ones through here, so a customer is checked the same way wherever they come from.
import { z } from "zod";
import { notFound } from "../../core/http.js";
import { read, write, wall, isUuid, asQ, insertRow, updateRow, pageOf, ONE } from "../db.js";
import { bad, conflict } from "../errors.js";
import { someKey, uuid } from "../shapes.js";
import { modules, customerUses } from "../modules.js";
import { cleanFields, hasId, normalPhone, same, telegramHandle } from "../shared/index.js";
import { addDays, dayOf } from "../shared/time.js";

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

/** The windowed snapshot's customers: these (the ones its rows are about) and every one added since `from` (a day), oldest first. */
export async function linkedCustomers(q, cfg, ids, from) {
  // Each one looked up by its index (ONE), so the work follows the window, not the whole list.
  const { rows } = await q(
    `SELECT ${customerCols("$2")}
       FROM (SELECT unnest($3::uuid[]) AS cid UNION SELECT id FROM crm_customers WHERE workspace_id = $1 AND created_at >= ($4::date::timestamp AT TIME ZONE $2)) x
       JOIN LATERAL (SELECT * FROM crm_customers WHERE workspace_id = $1 AND id = x.cid ${ONE}) c ON true
      ORDER BY created_at, id`,
    [cfg.workspaceId, cfg.timezone, ids, from]
  );
  return rows;
}

/** For the snapshot's counts: how many customers there are, and how many were added in the last 30 days (Today). */
export async function customerCounts(q, cfg) {
  const { rows } = await q(
    `SELECT (SELECT count(*)::int FROM crm_customers WHERE workspace_id = $1) AS total,
            (SELECT count(*)::int FROM crm_customers WHERE workspace_id = $1 AND created_at >= ($2::date::timestamp AT TIME ZONE $3)) AS "newMonth"`,
    [cfg.workspaceId, addDays(dayOf(cfg.now), -30), cfg.timezone]
  );
  return rows[0];
}

export const searchSchema = z
  .object({
    // Any part of the name, the phone (digits as stored: "+998901234567") or the Telegram handle, any letter case.
    q: z.string().trim().max(80),
    // The id of the last customer of the page before.
    after: uuid,
    limit: z.coerce.number().int().min(1).max(500),
  })
  .partial()
  .strict();

/** Customers oldest first, a page at a time, found by `q` when it is given: { customers, next }. */
export function searchCustomers(workspaceId, { q: words = "", after, limit = 100 }) {
  return read(workspaceId, async (q, cfg) => {
    const params = [cfg.workspaceId, cfg.timezone];
    const where = ["workspace_id = $1"];
    // The same expression as the index crm_customers_search (sql/crm/90-windowing.sql), so it is used.
    if (words) where.push(`lower(name || ' ' || phone || ' ' || telegram) LIKE $${params.push(`%${words.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`)}`);
    if (after) where.push(`(created_at, id) > (SELECT created_at, id FROM crm_customers WHERE workspace_id = $1 AND id = $${params.push(after)})`);
    const { rows } = await q(`SELECT ${customerCols("$2")} FROM crm_customers WHERE ${where.join(" AND ")} ORDER BY created_at, id LIMIT ${limit + 1}`, params);
    const page = pageOf(rows, limit);
    return { customers: page.rows, next: page.next };
  });
}

/**
 * The one customer of this workspace found by `by`, or null:
 *   { id }                     by the row's id (another workspace's id reads like one that doesn't exist)
 *   { phone }                  by phone number, in any form normalPhone() reads; two customers never share one
 *   { telegram, notFrom? }     by Telegram handle, in any form telegramHandle() reads, without regard to
 *                              letter case; null when two customers have it. `notFrom`: leave out the
 *                              customers who came from this source.
 * `lock`: "FOR UPDATE" inside a write.
 */
export async function findCustomer(q, cfg, by, lock = "") {
  const one = async (where, params, limit = 1) => {
    const { rows } = await q(`SELECT ${customerCols("$2")} FROM crm_customers WHERE workspace_id = $1 AND ${where} LIMIT ${limit} ${lock}`, [cfg.workspaceId, cfg.timezone, ...params]);
    return rows.length === 1 ? rows[0] : null;
  };
  if (by.id !== undefined) return isUuid(by.id) ? one("id = $3", [by.id]) : null;
  // `phone <> ''` and `telegram <> ''` let Postgres use the indexes that leave empty ones out.
  if (by.phone !== undefined) return normalPhone(by.phone) ? one("phone = $3 AND phone <> ''", [normalPhone(by.phone)]) : null;
  const handle = telegramHandle(by.telegram);
  return handle ? one("lower(telegram) = lower($3) AND telegram <> '' AND source IS DISTINCT FROM $4", [handle, by.notFrom ?? null], 2) : null;
}
async function getCustomer(q, cfg, id, lock) {
  const found = await findCustomer(q, cfg, { id }, lock);
  if (!found) throw notFound("Customer not found");
  return found;
}

/** These customers of the workspace, by id, in one query, each as findCustomer gives it. Ids it doesn't have are left out. */
export async function findCustomers(q, cfg, ids) {
  if (!ids.length) return [];
  const { rows } = await q(`SELECT ${customerCols("$2")} FROM crm_customers WHERE workspace_id = $1 AND id = ANY($3::uuid[])`, [cfg.workspaceId, cfg.timezone, ids]);
  return rows;
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
  for (const key of ["name", "instagram", "note"]) if (sent[key] !== undefined) out[key] = sent[key];
  // One way to keep a handle, so a Telegram chat finds its customer however the team typed it.
  if (sent.telegram !== undefined) out.telegram = telegramHandle(sent.telegram);
  if (sent.phone !== undefined) {
    // A customer may have no phone (someone who only writes on Instagram). A phone that is given must be a real one.
    out.phone = sent.phone === "" ? "" : normalPhone(sent.phone);
    if (out.phone === null) throw bad("Write the number like +998 90 123 45 67.", "bad_phone");
    const twin = out.phone && (await findCustomer(q, cfg, { phone: out.phone }));
    if (twin && twin.id !== stored?.id) throw conflict(`${twin.name} already has this number.`, "phone_taken", { customerId: twin.id, customerName: twin.name });
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

/**
 * Inside a write, for a customer who comes by themselves (a public page, the AI agent): the one
 * with this phone, or a new one with what they gave ({ name, phone, telegram? }), from `source`
 * (the caller's own, "website" or "ai", which the team's lists don't need to have). A known
 * customer keeps what the team stored. Answers { id, added: the new row | null }.
 */
export async function findOrAddCustomer(c, cfg, who, source) {
  const q = asQ(c);
  const known = await findCustomer(q, cfg, { phone: who.phone });
  if (known) return { id: known.id, added: null };
  const added = await insertCustomer(c, cfg, { ...(await cleanCustomer(q, cfg, { name: who.name, phone: who.phone, ...(who.telegram ? { telegram: who.telegram } : {}) })), source });
  return { id: added.id, added };
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
