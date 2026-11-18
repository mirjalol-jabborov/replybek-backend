// settings.notices: the switches and texts of the messages to customers, saved with the rest of
// CRM settings (PUT /settings { settings: { notices } }, saved whole). Everything is optional: a
// switch left out is on, a text left out or empty is the default one (shared/notices.js). The
// reminder's switch and timing are settings.remindOn and settings.remindBefore.
import { z } from "zod";
import { listId } from "../shapes.js";
import { NOTICE_KINDS, NOTICE_LANGUAGES, unknownPlaceholders, strayBraces } from "../shared/notices.js";

/**
 * A text in each language; each may use only the placeholders its kind fills, and every brace
 * must belong to a whole placeholder ("{name}"), so nothing unfilled reaches the customer.
 */
const textOf = (kind) =>
  z
    .object(Object.fromEntries(NOTICE_LANGUAGES.map((l) => [l, z.string().trim().max(1000)])))
    .partial()
    .strict()
    .superRefine((text, ctx) => {
      for (const [language, value] of Object.entries(text)) {
        if (strayBraces(value)) ctx.addIssue({ code: "custom", path: [language], message: "bad_placeholder" });
        for (const placeholder of unknownPlaceholders(kind, value)) ctx.addIssue({ code: "custom", path: [language], message: "unknown_placeholder", params: { placeholder } });
      }
    });

const kindShape = (kind, extra = {}) => z.object({ on: z.boolean(), text: textOf(kind), ...extra }).partial().strict();

const shapes = Object.fromEntries(Object.keys(NOTICE_KINDS).map((kind) => [kind, kindShape(kind)]));

export const settingsShape = {
  notices: z
    .object({
      // The language for customers whose own language isn't known.
      language: z.enum(NOTICE_LANGUAGES),
      ...shapes,
      reminder: z.object({ text: textOf("reminder") }).partial().strict(),
      // The order steps that tell the customer when an order enters them.
      orderStep: kindShape("orderStep", { steps: z.array(listId).max(30).transform((ids) => [...new Set(ids)]) }),
    })
    .partial()
    .strict(),
};
