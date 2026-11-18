// CRM settings: everything a business sets for itself, saved as a whole draft (PUT /settings).
// The app's editors already refuse the dangerous edits; the same rules are checked here, because
// two people can edit at once and the app's copy can be old.
import { z } from "zod";
import { HttpError } from "../../core/http.js";
import { write } from "../db.js";
import { TOP_KEYS } from "../defaults.js";
import { mergeChanges } from "../changes.js";
import { listId as id, hm, hmEnd, day, text, label } from "../shapes.js";
import { modules, add, countUses, moveStage, checkSettings } from "../modules.js";
import { APPT_KINDS, ORDER_KINDS, FIELD_TYPES, checkStages, moveTarget, removedIds } from "../shared/index.js";
import { toMin, isZoneName } from "../shared/time.js";
import { customerCols, sourceUses } from "./customers.js";

/* ───── Shapes ───── */

// A name is what someone typed, or {en, ru, uz} for the names a workspace starts with.
const name = label(80, 1);
const tone = z.enum(["", "blue", "green", "amber", "red"]);
const icon = z.string().regex(/^[A-Za-z0-9]{1,40}$/);
const minutes = (max) => z.number().int().min(0).max(max);

/** A list of items with ids, each id once. */
const list = (item, { min = 0, max = 100 } = {}) =>
  z
    .array(item)
    .min(min, min === 1 ? "At least one must stay." : undefined)
    .max(max)
    .superRefine((items, ctx) => {
      const seen = new Set();
      for (const [i, x] of items.entries()) {
        if (seen.has(x.id)) ctx.addIssue({ code: "custom", path: [i, "id"], message: "Two items have the same id." });
        seen.add(x.id);
      }
    });

const named = z.object({ id, name }).strict();
// "ai" marks what the Replybek AI agent brought in. It is not a channel a business can add.
const source = z.object({ id: id.refine((v) => v !== "ai", "This id is taken by the AI agent."), name, icon }).strict();
const tag = z.object({ id, name, tone }).strict();
const field = z
  .object({
    id,
    name,
    type: z.enum(FIELD_TYPES),
    options: z.array(text(80)).max(50).optional(),
    required: z.boolean().optional(),
    card: z.boolean().optional(),
  })
  .strict()
  // Only a choice has a list to choose from.
  .transform(({ options, ...f }) => (f.type === "choice" ? { ...f, options: [...new Set(options || [])] } : f));
const kindsOf = (kinds) => z.enum(kinds.map((k) => k.value));
const apptStage = z.object({ id, name, tone, kind: kindsOf(APPT_KINDS) }).strict();
const orderStage = z.object({ id, name, tone, kind: kindsOf(ORDER_KINDS), needs: z.object({ paid: z.boolean().optional(), fields: z.array(id).max(40).optional() }).strict().optional() }).strict();
const deliveryMethod = z.object({ id, name, icon, address: z.boolean(), fee: z.number().int().min(0).max(1_000_000_000) }).strict();

/** Booking rules (settings.rules). Saved whole. */
const rules = z
  .object({
    minNotice: minutes(43200),
    maxDays: z.number().int().min(1).max(730),
    cancelUntil: minutes(43200),
    buffer: minutes(480),
    step: z.number().int().min(5).max(240),
    override: z.boolean(),
  })
  .strict();
/** Delivery rules (settings.delivery). Saved whole. */
const delivery = z
  .object({
    time: z.enum(["windows", "exact", "both"]),
    windows: z
      .array(z.object({ from: hm, to: hmEnd }).strict().refine((w) => w.from < w.to, "A delivery window must end after it starts."))
      .max(24),
    daysOff: z.array(z.number().int().min(0).max(6)).max(7),
    closed: z.array(z.object({ date: day, note: z.union([z.string().trim().max(200), name]) }).strict()).max(366),
    sameDayUntil: z.union([hm, z.literal("")]),
    prepMinutes: minutes(43200),
    maxDays: z.number().int().min(1).max(730),
    override: z.boolean(),
  })
  .strict()
  .transform((d) => ({ ...d, windows: [...d.windows].sort((a, b) => (a.from < b.from ? -1 : 1)), daysOff: [...new Set(d.daysOff)].sort() }));

const move = z.object({ from: id, to: id }).strict();

function bodySchema() {
  const settings = z
    .object({
      dayStart: hm,
      dayEnd: hmEnd,
      slot: z.number().int().min(5).max(240),
      remindBefore: minutes(43200),
      remindOn: z.boolean(),
      confirmByAi: z.boolean(),
      lowStockAlerts: z.boolean(),
      aiConnected: z.boolean(),
      aiAct: z.boolean(),
      // The business's clock: kept as the workspace's time zone (crm_settings.timezone), not in the
      // settings. Checked in newZone, so every wrong value is the one code.
      timezone: z.unknown(),
      rules,
      delivery,
      ...Object.assign({}, ...modules.map((m) => m.settingsShape || {})),
    })
    .partial()
    .strict();
  return z
    .object({
      modules: z.object({ booking: z.boolean(), store: z.boolean() }).strict(),
      settings,
      sources: list(source, { min: 1 }),
      tags: list(tag),
      fields: z.object({ customer: list(field, { max: 40 }), appointment: list(field, { max: 40 }), order: list(field, { max: 40 }) }).partial().strict(),
      apptStages: list(apptStage, { max: 30 }),
      orderStages: list(orderStage, { max: 30 }),
      deliveryMethods: list(deliveryMethod, { min: 1 }),
      paymentMethods: list(named, { min: 1 }),
      units: list(named, { min: 1 }),
      serviceCategories: list(named),
      productCategories: list(named),
      // Where the items of a removed step go: { orderStages: [{ from, to }] }.
      moves: z.object({ apptStages: z.array(move).max(30), orderStages: z.array(move).max(30) }).partial().strict(),
    })
    .partial()
    .strict()
    .refine((b) => TOP_KEYS.some((k) => b[k] !== undefined), "Nothing to change.");
}
let built;
/** What PUT /settings takes. Built when the first request comes, so every module's own settings keys are in it. */
export const settingsSchema = z.lazy(() => (built ||= bodySchema()));

/* ───── Reading ───── */

const hasAgent = (workspace) => (workspace.products || []).includes("agent");

/**
 * The lists and settings as the app gets them. The AI agent shows as connected only when the
 * workspace has the agent product and switched the connection on. `settings.timezone` is the
 * business's clock (cfg.timezone), the zone every "now" of the server is read in.
 */
export function view(data, workspace, timezone) {
  return { ...data, settings: { ...data.settings, timezone, aiConnected: Boolean(data.settings.aiConnected) && hasAgent(workspace) } };
}

/**
 * The time zone to keep, when the save names another one: a zone name as the app's own check
 * takes it (isZoneName), that the database knows too, since every "now" of the CRM is read there
 * in it. Anything else is 400 bad_timezone.
 */
async function newZone(c, cfg, sent) {
  if (sent === undefined || sent === cfg.timezone) return null;
  const known = isZoneName(sent) && (await c.query("SELECT 1 FROM pg_timezone_names WHERE name = $1", [sent])).rows[0];
  if (!known) throw new HttpError(400, "Choose a time zone from the list.", { code: "bad_timezone" });
  return sent;
}

/* ───── Saving ───── */

const STAGES = { apptStages: APPT_KINDS, orderStages: ORDER_KINDS };
// Lists whose items other rows point at by id: an item in use can't be removed.
const GUARDED = ["sources", "deliveryMethods", "paymentMethods", "units", "serviceCategories", "productCategories"];
const shownName = (n) => (typeof n === "string" ? n : n?.en || Object.values(n || {}).find(Boolean) || "");
const SAY = {
  stage_fixed: "The one finishing step of each kind has to stay. It can be renamed.",
  stage_min: "The board needs at least one step of this kind. Rename it instead.",
  stage_in_use: "Empty this step first. What a step means can be changed only while it is empty.",
  stage_needs_move: "This step has items in it. Choose a step of the same kind for them to move to.",
  bad_move: "Items can only move from a removed step to a step of the same kind.",
};

/**
 * Saves the given top-level keys. `settings` and `fields` merge one level down (send only the
 * keys you edit); every other key replaces the stored list. Answers with the changes: the keys
 * that were sent, as stored, and the rows that changed with them (customers who lost a removed
 * tag, items moved out of a removed step).
 */
export function saveSettings(workspace, body) {
  return write(workspace.id, async (c, cfg) => {
    const before = cfg.data;
    const next = { ...before };
    for (const key of TOP_KEYS) {
      if (body[key] === undefined) continue;
      next[key] = key === "settings" || key === "fields" ? { ...before[key], ...body[key] } : body[key];
    }
    const zone = await newZone(c, cfg, body.settings?.timezone);
    if (body.settings) delete next.settings.timezone;
    if (toMin(next.settings.dayStart) >= toMin(next.settings.dayEnd)) throw new HttpError(400, "The day must end after it starts.", { code: "day_hours" });
    // Connecting the AI agent means something only for a workspace that has it.
    if (!hasAgent(workspace)) next.settings = { ...next.settings, aiConnected: false };

    for (const key of GUARDED) {
      if (body[key] === undefined) continue;
      const gone = removedIds(before[key], next[key]);
      const uses = await countUses(c, workspace.id, key, gone);
      if (key === "sources") add(uses, await sourceUses(c, workspace.id, gone));
      const [used] = Object.keys(uses);
      if (used) {
        const item = before[key].find((x) => x.id === used);
        throw new HttpError(409, `“${shownName(item.name)}” is in use. Change the places that use it first, then remove it.`, { code: "in_use", list: key, id: used, count: uses[used] });
      }
    }

    const changes = [];
    for (const [key, kinds] of Object.entries(STAGES)) {
      const moves = body.moves?.[key] || [];
      if (body[key] === undefined && !moves.length) continue;
      // Only steps that were removed or changed their meaning need counting.
      const touched = before[key].filter((s) => next[key].find((x) => x.id === s.id)?.kind !== s.kind).map((s) => s.id);
      const counts = await countUses(c, workspace.id, key, touched);
      const problems = checkStages({ kinds, before: before[key], after: next[key], moves, countOf: (sid) => counts[sid] || 0 });
      if (problems.length) {
        const first = problems[0];
        throw new HttpError(["stage_in_use", "stage_needs_move"].includes(first.code) ? 409 : 400, SAY[first.code], { ...first, list: key, problems });
      }
      for (const from of removedIds(before[key], next[key])) {
        if (counts[from]) changes.push(await moveStage(c, cfg, key, from, moveTarget(moves, from)));
      }
    }

    // A removed tag leaves every customer who had it.
    const goneTags = body.tags === undefined ? [] : removedIds(before.tags, next.tags);
    if (goneTags.length) {
      const { rows } = await c.query(
        `UPDATE crm_customers SET tags = ARRAY(SELECT t FROM unnest(tags) t WHERE t <> ALL($2::text[])), updated_at = now()
          WHERE workspace_id = $1 AND tags && $2::text[] RETURNING ${customerCols("$3")}`,
        [workspace.id, goneTags, cfg.timezone]
      );
      if (rows.length) changes.push({ set: { customers: rows } });
    }

    await checkSettings(c, cfg, next);
    await c.query("UPDATE crm_settings SET data = $2, timezone = COALESCE($3, timezone), updated_at = now() WHERE workspace_id = $1", [workspace.id, JSON.stringify(next), zone]);
    const shown = view(next, workspace, zone || cfg.timezone);
    return { changes: mergeChanges(...changes, { top: Object.fromEntries(TOP_KEYS.filter((k) => body[k] !== undefined).map((k) => [k, shown[k]])) }) };
  });
}
