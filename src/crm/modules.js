// The modules of the CRM: Booking and Store. Core (settings, customers, the snapshot) is always
// there and hosts them. A module lives in its own folder and exports these from its index.js,
// so core never has to know a module's tables:
//
//   keys             the snapshot keys it owns: ["orders", "products", "movements"]
//   router           its routes, mounted at /w/:wid/crm (req.workspace, req.role, req.user, req.crm are set)
//   snapshot(ctx)    → { [key]: rows } for the keys asked for (ctx.want(key)); ctx = { q, workspace, role, user, cfg, want }
// and, when it needs them:
//   me(ctx)                                  → { staffId }: what this signed-in person is in the module
//   countUses(c, workspaceId, list, ids)     → { [id]: n }: how many of its rows use these ids of a settings
//                                              list ("sources", "apptStages", "orderStages", "deliveryMethods",
//                                              "paymentMethods", "units", "serviceCategories", "productCategories")
//   moveStage(c, cfg, list, from, to)        → changes: re-point its rows from a removed step to another one
//   customerUses(c, workspaceId, customerId) → { [key]: n }: its rows that belong to a customer
//   customerHistory(ctx, customerId)         → { [key]: rows }: the same rows, for the customer's panel
//   settingsShape                            zod fields for settings keys of its own (PUT /settings checks them)
// `c` is the client of the write's transaction; `ctx.q(text, params)` reads inside the snapshot's.
import * as booking from "./booking/index.js";
import * as store from "./store/index.js";
import { mergeChanges } from "./changes.js";

export const modules = [booking, store];

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

/** Moves every item of a removed step to another step. Returns the changes. */
export async function moveStage(c, cfg, list, from, to) {
  const parts = [];
  for (const m of modules) if (m.moveStage) parts.push(await m.moveStage(c, cfg, list, from, to));
  return mergeChanges(...parts);
}

/** What still belongs to a customer: { appointments: 2, orders: 1 }. Empty when nothing does. */
export async function customerUses(c, workspaceId, customerId) {
  const total = {};
  for (const m of modules) if (m.customerUses) add(total, await m.customerUses(c, workspaceId, customerId));
  return total;
}
