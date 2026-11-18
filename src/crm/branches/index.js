// Branches: the places a business works from. What a module exports is described in ../modules.js;
// the routes are in routes.js. Every workspace has a default branch from its first CRM request
// (../db.js); the app shows nothing about branches until there are two. With one branch every
// answer of the other areas reads as it did before branches.
//
// What the other areas ask (which branch a write goes to, which rows a person may see, the places'
// hours) is in access.js: they import that file, since this one imports the Store for moving goods.
import { listBranches } from "./branches.js";

export { router } from "./routes.js";
export { scope, narrowTo } from "./access.js";
export const keys = ["branches"];

/** The snapshot's `branches`: all of them, or only theirs for a team member limited to one. */
export async function snapshot({ q, cfg, want, branchOnly }) {
  return want("branches") ? { branches: await listBranches(q, cfg, { only: branchOnly || null }) } : {};
}
