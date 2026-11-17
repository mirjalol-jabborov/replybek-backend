// The CRM's API: everything under /w/:wid/crm. It speaks the shapes the CRM app reads (camelCase,
// days as "2026-11-17", moments as "2026-11-17T09:30" on the business's clock), so the app's pages
// don't notice the server. Nothing in this folder imports the AI agent's code and the agent's code
// imports nothing from here: the two products meet only in src/bridge.
//
// Reads: GET /snapshot gives the whole workspace; ?only=orders,products gives just those keys.
// Writes answer with { changes: { set, del, top }, rev } (see changes.js), and every table says
// when it changed (crm_notify in sql/crm/00-core.sql), so other open screens fetch what moved.
import { Router } from "express";
import { HttpError, wrap } from "../lib/http.js";
import { stream } from "../services/events.service.js";
import { load, read } from "./db.js";
import { TOP_KEYS } from "./defaults.js";
import { modules } from "./modules.js";
import { router as core } from "./core/index.js";
import { view } from "./core/settings.js";
import { listCustomers } from "./core/customers.js";

const router = Router({ mergeParams: true });

// req.crm: the workspace's CRM (see load() in db.js), made on its first use. req.ctx(): what a
// module's snapshot and history hooks get.
router.use(wrap(async (req, res, next) => {
  req.crm = await load(req.workspace.id);
  req.ctx = (extra) => ({ workspace: req.workspace, role: req.role, user: req.user, cfg: req.crm, want: () => true, ...extra });
  next();
}));

// Who is looking, and the workspace around the rows. Always small, so every full snapshot has them.
const ABOUT = ["id", "name", "role", "me", "packages", "branches"];
const KEYS = () => new Set(["rev", ...ABOUT, ...TOP_KEYS, "customers", ...modules.flatMap((m) => m.keys)]);

/**
 * The workspace as the app's `db`. One unchanging picture: every part is read in the same
 * transaction, so `rev` and the rows belong together.
 */
async function snapshot(req, only) {
  return read(async (q) => {
    const cfg = await load(req.workspace.id, q);
    const want = (key) => !only || only.has(key);
    const ctx = req.ctx({ q, cfg, want });
    const out = { rev: cfg.rev };
    if (want("id")) out.id = req.workspace.id;
    if (want("name")) out.name = req.workspace.name;
    if (want("role")) out.role = req.role;
    if (want("packages")) out.packages = req.workspace.products;
    if (want("me")) {
      // A module can add what this person is to it: Booking links a team member to a specialist.
      out.me = { id: req.user.id, name: req.user.name, staffId: null };
      for (const m of modules) if (m.me) Object.assign(out.me, await m.me(ctx));
    }
    const lists = view(cfg.data, req.workspace);
    for (const key of TOP_KEYS) if (want(key)) out[key] = lists[key];
    if (want("branches")) {
      out.branches = (await q('SELECT id, name, address, is_default AS "default" FROM crm_branches WHERE workspace_id = $1 ORDER BY is_default DESC, created_at, id', [cfg.workspaceId])).rows;
    }
    if (want("customers")) out.customers = await listCustomers(q, cfg);
    for (const m of modules) {
      const mine = m.keys.filter(want);
      if (!mine.length) continue;
      const part = await m.snapshot(ctx);
      for (const key of mine) out[key] = part[key] || [];
    }
    return out;
  });
}

router.get("/snapshot", wrap(async (req, res) => {
  let only = null;
  if (typeof req.query.only === "string") {
    only = new Set(req.query.only.split(",").map((k) => k.trim()).filter(Boolean));
    const known = KEYS();
    const unknown = [...only].find((k) => !known.has(k));
    if (unknown) throw new HttpError(400, `There is no "${unknown}" in the snapshot.`, { code: "bad_key", key: unknown });
    // The editable lists are saved together and announced as one key, "settings": asking for it gives them all.
    if (only.has("settings")) for (const k of TOP_KEYS) only.add(k);
  }
  res.json(await snapshot(req, only));
}));

// Live updates for the CRM's screens: `event: crm` with data {"k": [snapshot keys]} (see
// events.service.js). GET /w/:wid/stream carries the same events; this stream carries only them,
// and an open CRM doesn't count as "someone is watching the inbox".
router.get("/stream", wrap((req, res) => stream(req, res, [`crm:${req.workspace.id}`])));

router.use(core);
for (const m of modules) router.use(m.router);

export default router;
