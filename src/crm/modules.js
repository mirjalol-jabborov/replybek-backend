// The modules of the CRM: Booking, Store, Notices and the public pages. Core (settings, customers, the snapshot) is always
// there and hosts them. The host (index.js) puts them into `modules` when it starts, so a module
// can use core and core can ask the modules without the two importing each other. A module lives
// in its own folder and exports these from its index.js, so core never has to know a module's tables:
//
//   keys             the snapshot keys it owns: ["orders", "products", "movements"]
//   router           its routes, mounted at /w/:wid/crm (req.workspace, req.role, req.user are set)
//   snapshot(ctx)    → { [key]: rows } for the keys asked for (ctx.want(key)); ctx = { q, workspace, role, user, cfg, want,
//                      branchId, recent, ids }. `recent` (?recent=1): { from (a day), days, moves }: a key that grows
//                      with the business's age is cut to that window, and `windows: { [key]: what it holds }` says so.
//                      `ids`: only these rows (the host also keeps every key to them, so a small list may ignore it).
// and, when it needs them:
//   counts(ctx)                              → { [key]: { name: n } }: numbers the sidebar and Today show, counted in the
//                                              database (snapshot key `counts`)
//   me(ctx)                                  → { staffId }: what this signed-in person is in the module
//   countUses(c, workspaceId, list, ids)     → { [id]: n }: how many of its rows use these ids of a settings
//                                              list ("sources", "apptStages", "orderStages", "deliveryMethods",
//                                              "paymentMethods", "units", "serviceCategories", "productCategories")
//   moveStage(c, cfg, list, from, to)        → changes: re-point its rows from a removed step to another one
//   customerUses(c, workspaceId, customerId) → { [key]: n }: its rows that belong to a customer
//   customerHistory(ctx, customerId)         → { [key]: rows }: the same rows, for the customer's panel
//   branchUses(c, cfg, branchId)             → { [key]: n }: its work still going on at a branch (closing
//                                              the branch waits until there is none)
//   settingsShape                            zod fields for settings keys of its own (PUT /settings checks them)
//   checkSettings(c, cfg, next)              before settings are saved (next: the lists and settings to
//                                              save): throws to refuse what only the database can tell
//   onChanges({ workspaceId, cfg }, changes) after any CRM write has committed, with its changes
//                                              (outside its transaction; cfg.rev is the write's rev)
// `c` is the client of the write's transaction; `ctx.q(text, params)` reads inside the snapshot's,
// and `ctx.cfg` is the workspace's CRM as read there (see read() in db.js).
import { mergeChanges } from "./changes.js";

/** The modules that are mounted, in the order their keys and routes come: Booking, Store, Notices, public pages. */
export const modules = [];

/**
 * After a write has committed: each module that wants to may act on what it changed (Notices
 * queues messages to customers). The write is already saved, so a module that fails is logged
 * and never fails it.
 */
export async function afterWrite(ctx, changes) {
  for (const m of modules) {
    if (!m.onChanges) continue;
    try {
      await m.onChanges(ctx, changes);
    } catch (e) {
      console.error(`After a CRM write in workspace ${ctx.workspaceId}:`, e.message);
    }
  }
}

/** Adds one part's counts into the total. */
export const add = (into, part) => {
  for (const [id, n] of Object.entries(part || {})) if (n > 0) into[id] = (into[id] || 0) + n;
  return into;
};

/** How many of the modules' rows use these ids of a settings list: { [id]: n }, only ids in use. */
export async function countUses(c, workspaceId, list, ids) {
  const total = {};
  if (ids.length) for (const m of modules) if (m.countUses) add(total, await m.countUses(c, workspaceId, list, ids));
  return total;
}

/** Lets each module refuse settings about to be saved. */
export async function checkSettings(c, cfg, next) {
  for (const m of modules) if (m.checkSettings) await m.checkSettings(c, cfg, next);
}

/** Moves every item of a removed step to another step. Returns the changes. */
export async function moveStage(c, cfg, list, from, to) {
  const parts = [];
  for (const m of modules) if (m.moveStage) parts.push(await m.moveStage(c, cfg, list, from, to));
  return mergeChanges(...parts);
}

/** What still goes on at a branch: { stock: 12, appointments: 3, orders: 1 }. Empty when nothing does. */
export async function branchUses(c, cfg, branchId) {
  const total = {};
  for (const m of modules) if (m.branchUses) add(total, await m.branchUses(c, cfg, branchId));
  return total;
}

/** What still belongs to a customer: { appointments: 2, orders: 1 }. Empty when nothing does. */
export async function customerUses(c, workspaceId, customerId) {
  const total = {};
  for (const m of modules) if (m.customerUses) add(total, await m.customerUses(c, workspaceId, customerId));
  return total;
}
