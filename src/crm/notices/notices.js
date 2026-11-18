// The messages a workspace sent or will send to its customers: the list (newest first, by
// customer, by item, paged) and sending a failed one again.
import { z } from "zod";
import { notFound } from "../../core/http.js";
import { read, write, wall, isUuid } from "../db.js";
import { conflict } from "../errors.js";
import { uuid } from "../shapes.js";
import { modules } from "../modules.js";
import { wake } from "./send.js";
import { staleReason } from "./decide.js";

/** The columns of a message as the app reads it. `tz`: the parameter holding the workspace's time zone. */
const NOTICE = (tz) => `id, customer_id AS "customerId", kind, json_build_object('key', item_key, 'id', item_id) AS item, channel, text, language,
  status, reason, ${wall("send_at", tz)} AS "sendAt", ${wall("sent_at", tz)} AS "sentAt", tries, ${wall("created_at", tz)} AS "createdAt"`;

export const listSchema = z
  .object({
    customerId: uuid,
    itemId: uuid,
    // The id of the last message of the page before: the page after it.
    before: uuid,
    limit: z.coerce.number().int().min(1).max(200),
  })
  .partial()
  .strict();

/**
 * The specialist whose bookings alone this person sees, or null: a team member linked to a
 * specialist with ownOnly sees only the messages about that specialist's bookings (orders all).
 * Asked through the modules, which know the team.
 */
async function ownOnlyStaff({ q, cfg, role, user }) {
  if (role !== "agent") return null;
  const want = (key) => key === "staff";
  for (const m of modules) {
    if (!m.keys.includes("staff")) continue;
    const { staff = [] } = await m.snapshot({ q, cfg, role, user, workspace: { id: cfg.workspaceId }, want });
    return staff.find((s) => s.userId === user.id && s.ownOnly)?.id || null;
  }
  return null;
}

/** Messages newest first: { notices, next } (`next`: pass it as `before` for the page after). */
export async function listNotices(ctx, { customerId, itemId, before, limit = 50 } = {}) {
  const { q, cfg } = ctx;
  const params = [cfg.workspaceId, cfg.timezone];
  const where = ["workspace_id = $1"];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replaceAll("$x", `$${params.length}`));
  };
  if (customerId) add("customer_id = $x", customerId);
  if (itemId) add("item_id = $x", itemId);
  if (before) add("(created_at, id) < (SELECT created_at, id FROM crm_notices WHERE workspace_id = $1 AND id = $x)", before);
  const own = await ownOnlyStaff(ctx);
  if (own) add("(item_key <> 'appointments' OR staff_id = $x)", own);
  const { rows } = await q(`SELECT ${NOTICE("$2")} FROM crm_notices WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`, params);
  return { notices: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1].id : null };
}

/** GET /notices for the people of a workspace. */
export const noticesFor = (ctx, filter) => read(ctx.workspace.id, (q, cfg) => listNotices({ ...ctx, q, cfg }, filter));

/**
 * Sends a failed message again, now. Its tries start again from zero. Only a failed message can be
 * sent again: one that was skipped had a reason not to go (the booking moved, nobody to send to),
 * and one about an item that changed since it was written would tell the customer something wrong.
 */
export async function retryNotice(workspaceId, id) {
  const out = await write(workspaceId, async (c, cfg) => {
    const { rows } = isUuid(id)
      ? await c.query(
          `SELECT n.status, n.kind, n.item_id, n.item_state, i.state FROM crm_notices n
             LEFT JOIN crm_notice_items i ON i.workspace_id = n.workspace_id AND i.item_key = n.item_key AND i.item_id = n.item_id
            WHERE n.workspace_id = $1 AND n.id = $2 FOR UPDATE OF n`,
          [workspaceId, id]
        )
      : { rows: [] };
    if (!rows[0]) throw notFound("Message not found");
    if (rows[0].status !== "failed") throw conflict("Only a message that failed can be sent again.", "not_failed", { status: rows[0].status });
    if (rows[0].kind === "reminder") {
      // A booking has one reminder waiting at most: a newer one (it moved since) replaces this one.
      const newer = await c.query("SELECT 1 FROM crm_notices WHERE workspace_id = $1 AND item_id = $2 AND kind = 'reminder' AND status = 'queued'", [workspaceId, rows[0].item_id]);
      if (newer.rows[0]) throw conflict("A newer reminder for this booking is already waiting.", "reminder_waiting");
    }
    const stale = staleReason(rows[0].item_state, rows[0].state);
    if (stale) throw conflict("What this message is about has changed since it was written.", stale);
    const updated = await c.query(
      `UPDATE crm_notices SET status = 'queued', reason = NULL, tries = 0, send_at = now(), claimed_at = NULL
        WHERE workspace_id = $1 AND id = $2 RETURNING ${NOTICE("$3")}`,
      [workspaceId, id, cfg.timezone]
    );
    return { changes: { set: { notices: updated.rows } } };
  });
  await wake(new Date());
  return out;
}
