// What the public pages accept. Everything is strict and small: anyone on the internet can send
// these. Text is kept as text (trimmed, control characters taken out); the app shows it escaped.
import { z } from "zod";
import { uuid, day, moment, hm, hmEnd } from "../shapes.js";
import { normalPhone } from "../shared/phone.js";
import { LEFT_CAP, tooMany } from "../shared/store.js";

// Control characters and the marks that turn text around. Outside a note, any run of spaces and
// line breaks is one space.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g;
const words = (max, { lines = false } = {}) =>
  z
    .string()
    .max(max * 2)
    .transform((v) => (lines ? v.replace(/\r\n?/g, "\n") : v.replace(/\s+/g, " ")).replace(CONTROL, "").trim())
    .pipe(z.string().max(max));

const name = words(80).pipe(z.string().min(1, "Add your name."));
// An Uzbek mobile number, stored as +998901234567.
const phone = z
  .string()
  .max(40)
  .transform((v) => normalPhone(v))
  .refine((v) => v !== null, { message: "Write the number like +998 90 123 45 67.", params: { code: "bad_phone" } });
const note = words(500, { lines: true }).default("");
// The honeypot: a field the page hides from people. Anything in it means a script filled the form.
const url = z.string().max(500).optional();

const csv = (max) => z.string().max(40 * max).transform((s) => [...new Set(s.split(",").map((x) => x.trim()).filter(Boolean))]).pipe(z.array(uuid).min(1).max(max));
const services = z.array(uuid).min(1).max(5).transform((ids) => [...new Set(ids)]);

export const slotsQuery = z.object({ day, serviceIds: csv(5), staffId: uuid.optional() }).strict();
export const daysQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Write the month like 2026-11."), serviceIds: csv(5), staffId: uuid.optional() }).strict();
export const lookupQuery = z.object({ token: z.string().min(1).max(100) }).strict();
export const tokenBody = z.object({ token: z.string().min(1).max(100) }).strict();

// Values for the booking and order fields the business needs (GET services and GET / list them):
// checked against each field's type when the booking or the order is made.
const fields = z
  .record(z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
  .refine((v) => Object.keys(v).length <= 50, "Too many fields.")
  .optional();
export const bookingBody = z
  .object({ serviceIds: services, staffId: uuid.nullable().optional(), start: moment, name, phone, note, fields, url })
  .strict();

// One order asks for at most what the page may show is left of a thing (the Store's tooMany, which
// binds every customer order), counted after its lines are merged. Asked here too, so the page
// gets its 400 before any work.
const line = z.object({ productId: uuid, variantId: uuid, qty: z.number().int().min(1).max(LEFT_CAP) }).strict();
/** The same variant on two lines is one line. */
function mergeLines(lines) {
  const byVariant = new Map();
  for (const l of lines) {
    const had = byVariant.get(l.variantId);
    byVariant.set(l.variantId, had ? { ...had, qty: had.qty + l.qty } : l);
  }
  return [...byVariant.values()];
}
export const orderBody = z
  .object({
    lines: z
      .array(line)
      .min(1)
      .max(30)
      .transform(mergeLines)
      .refine((lines) => !tooMany(lines).length, { message: `At most ${LEFT_CAP} of one thing.`, params: { code: "too_many", max: LEFT_CAP } }),
    name,
    phone,
    delivery: z
      .object({
        method: z.string().min(1).max(40),
        address: words(300).default(""),
        date: day,
        time: hm.optional(),
        window: z.object({ from: hm, to: hmEnd }).strict().optional(),
      })
      .strict(),
    payment: z.string().min(1).max(40),
    note,
    fields,
    url,
  })
  .strict();
