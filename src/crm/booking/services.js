// What customers can book: a name, how long it takes, the price, and the free time kept after it.
// Setting them up is for admins.
import { z } from "zod";
import { HttpError } from "../../lib/http.js";
import { write } from "../db.js";
import { hasId } from "../shared/index.js";
import { label, money, someKey } from "./shapes.js";
import { SERVICE, STAFF, asQ, one, insertRow, updateRow, upcomingOf } from "./rows.js";

const shape = {
  name: label(120, 1),
  category: z.string().trim().max(40),
  duration: z.number().int().min(5).max(1440),
  price: money,
  // Minutes kept free after it. null: the workspace's rule.
  buffer: z.number().int().min(0).max(480).nullable(),
  active: z.boolean(),
};
export const serviceCreateSchema = z.object(shape).partial().required({ name: true, duration: true }).strict();
export const serviceUpdateSchema = z.object(shape).partial().strict().refine(someKey, "Nothing to change.");

const MAP = { json: ["name"] };

/** A category must be one of the workspace's; the one a service already has stays valid. */
function cleanService(cfg, v, stored) {
  if (v.category && v.category !== stored?.category && !hasId(cfg.data.serviceCategories, v.category)) throw new HttpError(400, "This category no longer exists.", { code: "bad_category" });
}

export function createService(workspaceId, input) {
  return write(workspaceId, async (c, cfg) => {
    cleanService(cfg, input);
    const { rows } = await insertRow(c, "crm_services", MAP, SERVICE, { workspace_id: workspaceId }, input);
    return { changes: { set: { services: rows } }, id: rows[0].id };
  });
}

export function updateService(workspaceId, id, input) {
  return write(workspaceId, async (c, cfg) => {
    const stored = await one(asQ(c), cfg, "crm_services", SERVICE, id, "Service");
    cleanService(cfg, input, stored);
    const { rows } = await updateRow(c, "crm_services", MAP, SERVICE, workspaceId, id, input);
    return { changes: { set: { services: rows } } };
  });
}

/**
 * Deletes a service. Refused while bookings ahead or a running repeat booking use it: switch it
 * off instead, so nobody new can book it. Past bookings keep its id and read as a removed service.
 */
export function deleteService(workspaceId, id) {
  return write(workspaceId, async (c, cfg) => {
    const q = asQ(c);
    await one(q, cfg, "crm_services", SERVICE, id, "Service");
    const using = await upcomingOf(q, cfg, { serviceId: id });
    const series = (await c.query("SELECT count(*)::int AS n FROM crm_series WHERE workspace_id = $1 AND $2 = ANY(service_ids) AND (until IS NULL OR until > through)", [workspaceId, id])).rows[0].n;
    if (using.length || series) {
      throw new HttpError(409, "Bookings ahead use this service. Move or cancel them first, or switch the service off.", { code: "service_has_bookings", count: using.length, ids: using.map((a) => a.id), series });
    }
    const { rows } = await c.query(`UPDATE crm_staff SET service_ids = array_remove(service_ids, $2) WHERE workspace_id = $1 AND $2 = ANY(service_ids) RETURNING ${STAFF}`, [workspaceId, id]);
    await c.query("DELETE FROM crm_services WHERE workspace_id = $1 AND id = $2", [workspaceId, id]);
    return { changes: { del: { services: [id] }, ...(rows.length ? { set: { staff: rows } } : {}) } };
  });
}
