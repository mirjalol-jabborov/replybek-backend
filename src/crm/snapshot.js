// GET /snapshot: the workspace as the app's `db`. Three ways to ask (CONTRACT.md, AS-BUILT-snapshot.md):
//   (nothing)                       every key, every row
//   ?recent=1[&days=30][&moves=200][&customers=all|linked]
//                                   the keys that grow with the business's age cut to a window, with
//                                   `windows` (what was cut) and `counts` (the sidebar's and Today's numbers)
//   ?only=orders&ids=a,b            just these rows of one key, with `gone` (ids it no longer has for this person)
// ?only=a,b narrows any of them to those keys; ?branch=<id> to one branch. Every part is read in one
// transaction, so `rev` and the rows belong together.
import { HttpError } from "../core/http.js";
import { read, isUuid } from "./db.js";
import { TOP_KEYS } from "./defaults.js";
import { modules } from "./modules.js";
import { view } from "./core/settings.js";
import { agentsOf } from "./core/ai-link.js";
import { listCustomers, linkedCustomers, findCustomers, customerCounts } from "./core/customers.js";
import { narrowTo } from "./branches/index.js";
import { addDays, dayOf } from "./shared/time.js";

// Who is looking, and the workspace around the rows. Always small, so every full snapshot has them.
const ABOUT = ["id", "name", "role", "me", "packages"];
const rowKeys = () => ["customers", ...modules.flatMap((m) => m.keys)];
// Sent only when asked for, or with ?recent=1: the full snapshot stays as it always was.
const EXTRA = ["counts"];
const MAX_IDS = 200;
const WINDOW = { days: { min: 1, max: 366, default: 30 }, moves: { min: 1, max: 1000, default: 200 } };

const refuse = (message, code, extra) => new HttpError(400, message, { code, ...extra });

/** A whole number from the query between min and max, or its default when it isn't there. */
function count(query, name) {
  const { min, max, default: dflt } = WINDOW[name];
  if (query[name] === undefined) return dflt;
  const n = Number(query[name]);
  if (typeof query[name] !== "string" || !Number.isInteger(n) || n < min || n > max) throw refuse(`${name} is a whole number from ${min} to ${max}.`, "bad_window", { param: name, min, max });
  return n;
}

/** What the query asks for: { only: Set | null, recent: { days, moves, customers } | null, ids: [ids] | null }. */
export function parseAsk(query) {
  let only = null;
  if (typeof query.only === "string") {
    only = new Set(query.only.split(",").map((k) => k.trim()).filter(Boolean));
    const known = new Set(["rev", ...ABOUT, ...TOP_KEYS, ...rowKeys(), ...EXTRA]);
    const unknown = [...only].find((k) => !known.has(k));
    if (unknown) throw refuse(`There is no "${unknown}" in the snapshot.`, "bad_key", { key: unknown });
    // The editable lists are saved together and announced as one key, "settings": asking for it gives them all.
    if (only.has("settings")) for (const k of TOP_KEYS) only.add(k);
  }
  let recent = null;
  if (query.recent !== undefined) {
    if (query.recent !== "1") throw refuse("recent is 1 or left out.", "bad_window", { param: "recent" });
    const customers = query.customers ?? "all";
    if (customers !== "all" && customers !== "linked") throw refuse("customers is all or linked.", "bad_window", { param: "customers" });
    recent = { days: count(query, "days"), moves: count(query, "moves"), customers };
  }
  let ids = null;
  if (query.ids !== undefined) {
    const key = only?.size === 1 ? [...only][0] : null;
    if (!key || !rowKeys().includes(key) || recent) throw refuse("ids go with one row key in only, and without recent.", "bad_ids");
    if (typeof query.ids !== "string") throw refuse("ids is a comma list.", "bad_ids");
    ids = [...new Set(query.ids.split(",").map((s) => s.trim()).filter(Boolean))];
    if (ids.length > MAX_IDS) throw refuse(`At most ${MAX_IDS} ids at once.`, "too_many_ids", { max: MAX_IDS });
    if (!ids.every(isUuid)) throw refuse("An id doesn't look right.", "bad_ids");
  }
  return { only, recent, ids };
}

/** The ids of the customers these rows are about. */
const customersOf = (parts) => [...new Set(parts.flatMap((rows) => (Array.isArray(rows) ? rows.map((r) => r.customerId).filter(Boolean) : [])))];

/** The snapshot for this request, as `parseAsk` read it. */
export function snapshot(req, { only, recent, ids }) {
  return read(req.workspace.id, async (q, cfg) => {
    const want = (key) => (only ? only.has(key) : !EXTRA.includes(key) || Boolean(recent));
    // The window starts at midnight `days` days ago on the business's clock.
    const window = recent && { ...recent, from: addDays(dayOf(cfg.now), -recent.days) };
    const ctx = req.ctx({ q, cfg, want, recent: window, ids, branchId: await narrowTo(q, cfg, req.query.branch, req.branchOnly) });
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
    const lists = view(cfg.data, req.workspace, cfg.timezone, want("settings") ? await agentsOf(q, req.workspace) : []);
    for (const key of TOP_KEYS) if (want(key)) out[key] = lists[key];
    const windows = {};
    // Linked customers are those the window's rows are about, so those rows are read even when only
    // the customers were asked for (then they are left out of the answer).
    const linked = want("customers") && window?.customers === "linked";
    if (want("customers") && !linked) out.customers = ids ? await findCustomers(q, cfg, ids) : await listCustomers(q, cfg);
    const about = [];
    for (const m of modules) {
      const mine = m.keys.filter(want);
      if (!mine.length && !(linked && m.keys.length)) continue;
      const part = await m.snapshot(linked ? { ...ctx, want: () => true } : ctx);
      about.push(...Object.values(part));
      for (const key of mine) {
        out[key] = part[key] || [];
        if (window && part.windows?.[key]) windows[key] = part.windows[key];
      }
    }
    if (linked) {
      out.customers = await linkedCustomers(q, cfg, customersOf(about), window.from);
      windows.customers = { from: window.from, linked: true };
    }
    if (want("counts")) {
      out.counts = { day: dayOf(cfg.now), customers: await customerCounts(q, cfg) };
      for (const m of modules) if (m.counts) Object.assign(out.counts, await m.counts(ctx));
    }
    if (window) out.windows = windows;
    if (ids) {
      // Only these rows, for this person: a module reads its big keys by id; this keeps every key to them.
      const key = [...only][0];
      const asked = new Set(ids);
      out[key] = out[key].filter((r) => asked.has(r.id));
      const found = new Set(out[key].map((r) => r.id));
      out.gone = { [key]: ids.filter((id) => !found.has(id)) };
    }
    return out;
  });
}
