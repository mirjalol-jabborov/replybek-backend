// The pieces Booking's request shapes are built from, so a time or a name is checked the same way
// by every route of the module.
import { z } from "zod";
import { isDay } from "../shared/index.js";
import { isMoment } from "../shared/time.js";

export const uuid = z.string().uuid();
const once = (ids) => [...new Set(ids)];
/** A list of ids, each kept once. */
export const uuids = (max) => z.array(uuid).max(max).transform(once);
/** The services of a visit. */
export const serviceList = z.array(uuid).min(1, "Choose at least one service.").max(20).transform(once);
export const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Write the time like 09:30.");
/** The end of a working day may be midnight. */
export const hmEnd = z.union([hm, z.literal("24:00")]);
export const day = z.string().refine(isDay, "Write the day like 2026-11-17.");
export const moment = z.string().refine(isMoment, "Write the moment like 2026-11-17T09:30.");
export const money = z.number().int().min(0).max(1_000_000_000_000);
export const minutes = z.number().int().min(1).max(1440);
const translated = (max) =>
  z.object({ en: z.string().trim().max(max), ru: z.string().trim().max(max), uz: z.string().trim().max(max) }).partial().strict();
/** What someone typed, or { en, ru, uz } for sample names. `min: 1`: it can't be empty. */
export const label = (max, min = 0) =>
  z.union([z.string().trim().min(min).max(max), min ? translated(max).refine((n) => Object.values(n).some(Boolean), "A name can't be empty.") : translated(max)]);
/** A partial update must change something. */
export const someKey = (v) => Object.keys(v).length > 0;
