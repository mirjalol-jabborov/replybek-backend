import { query } from "../db.js";
import { notFound, forbidden, HttpError } from "../http.js";
import { writeRefusal } from "../billing/product-access.js";

const RANK = { agent: 1, admin: 2, owner: 3 };

/**
 * For routes under /w/:wid. Checks the signed-in user belongs to the workspace and sets
 * req.workspace and req.role. Someone outside the workspace gets 404, so ids don't leak.
 * Until the person confirms their email address no workspace opens: 403 { code: "email_unverified" },
 * the one check for every workspace route of both products (the confirmation itself is under /auth).
 */
export async function requireWorkspace(req, res, next) {
  try {
    if (!req.user.email_verified) throw new HttpError(403, "Confirm your email address to open the workspace.", { code: "email_unverified" });
    const { wid } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(wid)) throw notFound("Workspace not found");
    const { rows } = await query(
      `SELECT w.*, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
        WHERE w.id = $1 AND m.user_id = $2`,
      [wid, req.user.id]
    );
    if (!rows[0]) throw notFound("Workspace not found");
    const { role, ...workspace } = rows[0];
    req.workspace = workspace;
    req.role = role;
    next();
  } catch (e) {
    next(e);
  }
}

/** Requires at least this role: agent < admin < owner. */
export const requireRole = (role) => (req, res, next) => (RANK[req.role] >= RANK[role] ? next() : next(forbidden("Only workspace admins can do this.")));

const PRODUCT = { agent: "the AI agent", crm: "the CRM" };
const READS = new Set(["GET", "HEAD", "OPTIONS"]);

// Products whose read-only lock is this guard, with the paths under the product that stay open
// while it is locked (a check that saves nothing). The AI agent's lock is readOnlyUntilTrial below,
// because it also covers the routes every workspace has.
const LOCKED_HERE = { crm: [/^\/booking\/check$/] };

/**
 * For routes that belong to one product. A workspace has the AI agent, the CRM or both
 * (workspaces.products); a workspace without the product gets 404 { code: "product_off" }, and
 * its data stays for when the product comes back. While the product is billed, reads always
 * work and writes need its trial or a paid package that gives it (402, see writeRefusal).
 */
export const requireProduct = (product) => (req, res, next) => {
  if (!req.workspace.products?.includes(product)) return next(new HttpError(404, `This workspace doesn't have ${PRODUCT[product]}.`, { code: "product_off", product }));
  const open = LOCKED_HERE[product];
  if (!open || READS.has(req.method) || open.some((re) => re.test(req.path))) return next();
  next(writeRefusal(req.workspace, product) || undefined);
};

// What exists only with the AI agent: agents (with their knowledge, channels and playground),
// the inbox and its files, integrations, analytics and the agent's onboarding. The rest of
// /w/:wid (the workspace itself, the stream, the team, billing, activity, products, the CRM) is
// for every workspace. Express matches paths whatever their letter case ("/AGENTS" reaches the
// agents router), so this test ignores case too.
const AGENT_ONLY = /^\/(agents|sources|unanswered|conversations|files|integrations|analytics|onboarding)(\/|$)/i;
const needsAgent = requireProduct("agent");
/** Closes the AI agent's routes to a workspace that only has the CRM. */
export const agentRoutesNeedAgent = (req, res, next) => (AGENT_ONLY.test(req.path) ? needsAgent(req, res, next) : next());

// What a workspace can still change while it's read-only: paying, finishing onboarding, testing in the
// Playground (capped at PREVIEW_MESSAGES answers) and answering people already waiting in the inbox.
const OPEN_WHILE_LOCKED = [/^\/plan$/, /^\/billing\//, /^\/onboarding\//, /^\/agents\/[^/]+\/test$/, /^\/conversations\/[^/]+\/[\w-]+$/];

/**
 * Before the free trial starts (or once the subscription has ended) the workspace is read-only:
 * everything can be viewed, nothing added or changed. Onboarding is the exception, since it builds
 * the first agent before the trial; the dashboard keeps such workspaces in onboarding until it's done.
 * The AI agent's routes follow the AI agent's access; the routes every workspace has follow its
 * subscription, whatever the package.
 */
export function readOnlyUntilTrial(req, res, next) {
  if (READS.has(req.method)) return next();
  if (!req.workspace.settings?.onboarded) return next();
  if (OPEN_WHILE_LOCKED.some((re) => re.test(req.path))) return next();
  next(writeRefusal(req.workspace, AGENT_ONLY.test(req.path) ? "agent" : null) || undefined);
}
