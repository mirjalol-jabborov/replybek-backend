// The pieces every area's request shapes are built from, so an id, a sum, a time or a name is
// checked the same way by every route of the CRM.
import { z } from "zod";
import { isDay } from "./shared/index.js";
import { isMoment } from "./shared/time.js";
import { isUuid } from "./db.js";

/** A row's id. */
export const uuid = z.string().refine(isUuid, "This id doesn't look right.");
/** Ids, each kept once. */
export const uuids = (max) => z.array(uuid).max(max).transform((ids) => [...new Set(ids)]);
/** The services of a visit. */
export const serviceList = z.array(uuid).min(1, "Choose at least one service.").max(20).transform((ids) => [...new Set(ids)]);
/** An id inside one of the workspace's lists: short strings the app makes up ("st4k2j9", "tagm1x"). */
export const listId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, "An id is 1 to 40 letters, digits, - or _.");
/** Whole soʻm. */
export const money = z.number().int().min(0).max(1_000_000_000_000);
export const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Write the time like 09:30.");
/** The end of a working day may be midnight. */
export const hmEnd = z.union([hm, z.literal("24:00")]);
export const day = z.string().refine(isDay, "Write the day like 2026-11-17.");
/** Working hours for every weekday, 0 = Sunday: ["10:00", "20:00"], or null for a day off. */
const dayHours = z.union([z.null(), z.tuple([hm, hmEnd]).refine(([from, to]) => from < to, "The working day must end after it starts.")]);
export const weekHours = z.object({ 0: dayHours, 1: dayHours, 2: dayHours, 3: dayHours, 4: dayHours, 5: dayHours, 6: dayHours }).strict();
export const moment = z.string().refine(isMoment, "Write the moment like 2026-11-17T09:30.");
/** How long a visit takes. */
export const minutes = z.number().int().min(1).max(1440);
/** Text that can't be empty. */
export const text = (max) => z.string().trim().min(1).max(max);
const translated = (max) => z.object({ en: z.string().trim().max(max), ru: z.string().trim().max(max), uz: z.string().trim().max(max) }).partial().strict();
/** What someone typed, or { en, ru, uz } for sample names. `min: 1`: it can't be empty. */
export const label = (max, min = 0) =>
  z.union([z.string().trim().min(min).max(max), min ? translated(max).refine((n) => Object.values(n).some(Boolean), "A name can't be empty.") : translated(max)]);
/** A partial update must change something. */
export const someKey = (v) => Object.keys(v).length > 0;
