// The public pages' settings: settings.publicPage, saved whole through PUT /settings like
// settings.rules. Core checks it with the shape below (registered in ../modules.js).
import { z } from "zod";
import { label, listId } from "../shapes.js";
import { normalPhone } from "../shared/phone.js";
import { hasId } from "../shared/lists.js";
import { slugProblem } from "./rules.js";

/** The languages a page can speak: the CRM's three. The first one is the page's default. */
const PAGE_LANGUAGES = ["uz", "ru", "en"];
const once = (list) => [...new Set(list)];

const page = z
  .object({
    // The page's name in the address. "" = no address yet: the pages stay closed.
    slug: z
      .string()
      .max(40)
      .superRefine((v, ctx) => {
        const problem = slugProblem(v);
        if (problem) ctx.addIssue({ code: "custom", message: "Use 3 to 40 lowercase letters, digits and hyphens.", params: problem });
      }),
    booking: z.boolean(), // the booking page is on (it also needs the Booking module)
    shop: z.boolean(), // the shop page is on (it also needs the Store module)
    description: label(300),
    phone: z
      .string()
      .trim()
      .max(40)
      .refine((v) => v === "" || normalPhone(v), { message: "Write the number like +998 71 123 45 67.", params: { code: "bad_phone" } })
      .transform((v) => (v ? normalPhone(v) : "")),
    address: z.string().trim().max(300),
    languages: z.array(z.enum(PAGE_LANGUAGES)).min(1).max(3).transform(once),
    // Which of the workspace's payment and delivery methods customers may choose on the shop page.
    paymentMethods: z.array(listId).max(50).transform(once),
    deliveryMethods: z.array(listId).max(50).transform(once),
  })
  .strict();

/** What core's PUT /settings takes for this area: settings.publicPage. */
export const settingsShape = { publicPage: page };

const DEFAULTS = { slug: "", booking: false, shop: false, description: "", phone: "", address: "", languages: PAGE_LANGUAGES, paymentMethods: [], deliveryMethods: [] };

/**
 * The page settings of a workspace's CRM (`cfg` from db.js), with what it lacks filled in and
 * only methods that are still in the workspace's lists. `on`: which pages are open, each needing
 * its module too.
 */
export function pageOf(cfg) {
  const p = { ...DEFAULTS, ...(cfg.data.settings.publicPage || {}) };
  const { modules, paymentMethods, deliveryMethods } = cfg.data;
  return {
    ...p,
    paymentMethods: paymentMethods.filter((m) => p.paymentMethods.includes(m.id)),
    deliveryMethods: deliveryMethods.filter((m) => p.deliveryMethods.includes(m.id)),
    on: { booking: Boolean(p.slug && p.booking && modules.booking), shop: Boolean(p.slug && p.shop && modules.store) },
  };
}

/**
 * Who makes a booking or an order on a page, to the modules: a customer acting for themselves,
 * from the workspace's "website" source while it has one, held to the daily share.
 */
export const pageCustomer = (cfg) => ({ by: "customer", via: "page", source: hasId(cfg.data.sources, "website") ? "website" : "", capped: true });
