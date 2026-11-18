// The places a business works from: adding one, editing it, closing it, deleting one nothing
// happened at. The default branch is always there: it can be renamed, never closed or removed.
// A branch closes once nothing goes on there any more; closed, it takes no new work and keeps its
// history (and whatever comes back to it, such as returned goods).
import { z } from "zod";
import { notFound } from "../../core/http.js";
import { write, insertRow, updateRow, isUuid } from "../db.js";
import { branchUses } from "../modules.js";
import { bad, conflict } from "../errors.js";
import { uuid, weekHours, someKey } from "../shapes.js";
import { normalPhone } from "../shared/phone.js";

/**
 * A branch as the app reads it: { id, name, address, phone, hours, active, default, members }.
 * `members`: the team members limited to it (user ids). `name` is "" for a default branch that
 * goes by the workspace's name.
 */
export const BRANCH = `b.id, b.name, b.address, b.phone, b.hours, b.active, b.is_default AS "default",
  COALESCE((SELECT array_agg(m.user_id ORDER BY m.created_at, m.user_id) FROM crm_member_branches m
             WHERE m.workspace_id = b.workspace_id AND m.branch_id = b.id), '{}') AS members`;

/** The workspace's branches, the default one first. `only`: just that one (a limited team member's). */
export async function listBranches(q, cfg, { only = null, ids = null } = {}) {
  const { rows } = await q(
    `SELECT ${BRANCH} FROM crm_branches b
      WHERE b.workspace_id = $1 AND ($2::uuid IS NULL OR b.id = $2) AND ($3::uuid[] IS NULL OR b.id = ANY($3::uuid[]))
      ORDER BY b.is_default DESC, b.created_at, b.id`,
    [cfg.workspaceId, only, ids]
  );
  return rows;
}

/** One branch of the workspace, or 404. */
async function getBranch(q, cfg, id) {
  const [row] = isUuid(id) ? await listBranches(q, cfg, { ids: [id] }) : [];
  if (!row) throw notFound("Branch not found");
  return row;
}

/* ───── Shapes ───── */

const shape = {
  name: z.string().trim().max(120),
  address: z.string().trim().max(300),
  phone: z.string().trim().max(40),
  // Its own working days and hours, 0 = Sunday; null: the specialists' own hours count.
  hours: weekHours.nullable(),
  active: z.boolean(),
};
export const branchCreateSchema = z.object(shape).partial().required({ name: true }).strict();
export const branchUpdateSchema = z.object(shape).partial().strict().refine(someKey, "Nothing to change.");

const MAP = { json: ["hours"] };

/** The fields as stored: a phone in one form ("+998712000000") or empty. */
function clean(v) {
  if (v.phone === undefined || v.phone === "") return v;
  const phone = normalPhone(v.phone);
  if (!phone) throw bad("Write the phone number like +998 71 200 00 00.", "bad_phone");
  return { ...v, phone };
}

/* ───── Writes ───── */

/** A new branch. It needs a name: only the default one may go by the workspace's. */
export function createBranch(workspaceId, input) {
  return write(workspaceId, async (c, cfg, q) => {
    if (!input.name) throw bad("Give the branch a name.", "name_required");
    const [{ id }] = await insertRow(c, cfg, "crm_branches", MAP, "id", clean(input));
    return { changes: { set: { branches: [await getBranch(q, cfg, id)] } }, id };
  });
}

/**
 * Edits a branch. Closing one (`active: false`) waits until nothing goes on there: goods on its
 * shelves, bookings ahead, repeat bookings that go on, orders still open (each module says what is
 * its own, branchUses in ../modules.js) and team members limited to it: 409 branch_busy with
 * `busy: { stock?, appointments?, series?, orders?, members? }`, the kinds that have something
 * (stock in units, the others counted). The default branch stays open. Reopening always works.
 */
export function updateBranch(workspaceId, id, input) {
  return write(workspaceId, async (c, cfg, q) => {
    const stored = await getBranch(q, cfg, id);
    if (input.name === "" && !stored.default) throw bad("Give the branch a name.", "name_required");
    if (input.active === false && stored.default) throw conflict("The main branch can't be closed.", "default_branch");
    if (input.active === false && stored.active) {
      const busy = { ...(await branchUses(c, cfg, id)), ...(stored.members.length ? { members: stored.members.length } : {}) };
      if (Object.keys(busy).length) throw conflict("Something still goes on at this branch. Move or finish it, then close the branch.", "branch_busy", { busy });
    }
    await updateRow(c, cfg, "crm_branches", MAP, "id", id, clean(input));
    return { changes: { set: { branches: [await getBranch(q, cfg, id)] } } };
  });
}

// What still points at a branch, by the table the database names, as the snapshot calls it.
const USED_BY = {
  crm_staff: "staff", crm_time_off: "timeOff", crm_series: "series", crm_appointments: "appointments",
  crm_orders: "orders", crm_stock_moves: "movements", crm_stock: "movements", crm_member_branches: "members",
};

/**
 * Deletes a branch nothing ever happened at. One with a specialist, a closed day, a booking, an
 * order, a stock line or a team member limited to it stays (409 branch_in_use, `uses`: the first
 * kind of row the database found): close it instead. The database's own foreign keys decide, so
 * no table of another area is read here.
 */
export function deleteBranch(workspaceId, id) {
  return write(workspaceId, async (c, cfg, q) => {
    const stored = await getBranch(q, cfg, id);
    if (stored.default) throw conflict("The main branch can't be deleted.", "default_branch");
    await c.query("SAVEPOINT branch");
    try {
      await c.query("DELETE FROM crm_branches WHERE workspace_id = $1 AND id = $2", [cfg.workspaceId, id]);
    } catch (e) {
      if (e.code !== "23503") throw e;
      await c.query("ROLLBACK TO SAVEPOINT branch");
      throw conflict("Something still happens at this branch, so it can't be deleted. Close it instead.", "branch_in_use", { uses: USED_BY[e.table] || "" });
    }
    return { changes: { del: { branches: [id] } } };
  });
}

/* ───── A team member at one branch ───── */

export const memberSchema = z.object({ branchId: uuid.nullable() }).strict();

/**
 * Limits a team member to one branch, or (branchId null) lets them see every branch again. It
 * counts while their role is `agent`. Answers with the branches whose `members` changed.
 */
export function limitMember(workspaceId, userId, { branchId }) {
  return write(workspaceId, async (c, cfg, q) => {
    const member = isUuid(userId) && (await c.query("SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2", [cfg.workspaceId, userId])).rows[0];
    if (!member) throw notFound("Team member not found");
    const before = (await c.query("SELECT branch_id FROM crm_member_branches WHERE workspace_id = $1 AND user_id = $2", [cfg.workspaceId, userId])).rows[0]?.branch_id || null;
    if (branchId === before) return { changes: {} };
    if (branchId) {
      const branch = await getBranch(q, cfg, branchId).catch(() => null);
      if (!branch) throw bad("This branch doesn't exist.", "bad_branch");
      if (!branch.active) throw conflict("This branch is closed.", "branch_closed", { branchId });
      await c.query(
        `INSERT INTO crm_member_branches (workspace_id, user_id, branch_id) VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET branch_id = EXCLUDED.branch_id, created_at = now()`,
        [cfg.workspaceId, userId, branchId]
      );
    } else {
      await c.query("DELETE FROM crm_member_branches WHERE workspace_id = $1 AND user_id = $2", [cfg.workspaceId, userId]);
    }
    return { changes: { set: { branches: await listBranches(q, cfg, { ids: [before, branchId].filter(Boolean) }) } } };
  });
}
