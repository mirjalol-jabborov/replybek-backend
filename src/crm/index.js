// The CRM's API: everything under /w/:wid/crm. It speaks the shapes the CRM app reads (camelCase,
// days as "2026-11-17", moments as "2026-11-17T09:30" on the business's clock), so the app's pages
// don't notice the server. Nothing in this folder imports the AI agent's code and the agent's code
// imports nothing from here: the two products meet only in src/bridge.
//
// Reads: GET /snapshot gives the whole workspace; ?only=orders,products gives just those keys;
// ?recent=1 cuts the keys that grow to a window; ?only=orders&ids=a,b gives just those rows.
// Writes answer with { changes: { set, del, top }, rev } (see changes.js), and every table says
// when it changed (sql/crm/00-core.sql), so other open screens fetch what moved.
import { Router } from "express";
import { wrap } from "../core/http.js";
import { stream } from "../core/events.js";
import { modules } from "./modules.js";
import { snapshot, parseAsk } from "./snapshot.js";
import * as booking from "./booking/index.js";
import * as store from "./store/index.js";
import * as notices from "./notices/index.js";
import * as publicPages from "./public/index.js";
import * as reports from "./reports/index.js";
import * as exchange from "./exchange/index.js";
import { router as core } from "./core/index.js";
import * as branches from "./branches/index.js";

modules.push(booking, store, notices, publicPages, reports, exchange, branches);

const router = Router({ mergeParams: true });

// req.ctx(): what a module's snapshot and history hooks get (read() adds q and cfg). Nothing is
// read here: the workspace's CRM is read by the read or write that needs it, made on its first use.
// branchOnly: the branch a team member is limited to (set by branches.scope); branchId: the branch
// the rows are narrowed to (theirs, or the snapshot's ?branch=).
router.use((req, res, next) => {
  req.ctx = (extra) => ({ workspace: req.workspace, role: req.role, user: req.user, want: () => true, branchOnly: req.branchOnly, branchId: req.branchOnly, ...extra });
  next();
});
router.use(branches.scope);

// The workspace as the app's `db`, whole, windowed (?recent=1) or a few rows by id (snapshot.js).
router.get("/snapshot", wrap(async (req, res) => res.json(await snapshot(req, parseAsk(req.query)))));

// Live updates for the CRM's screens: `event: crm` with data {"k": [snapshot keys]} (see
// src/core/events.js). GET /w/:wid/stream carries the same events; this stream carries only them,
// and an open CRM doesn't count as "someone is watching the inbox". ?rows=1: the events also say
// which rows changed ({ k, ids, del, revs }), so a screen fetches those rows instead of whole keys.
router.get("/stream", wrap((req, res) => stream(req, res, [`crm:${req.workspace.id}`], undefined, { rows: req.query.rows === "1" })));

router.use(core);
for (const m of modules) router.use(m.router);

export default router;
