// Finding a public page by its address and telling what it may show. An unknown address, a page
// that is switched off and a workspace without the CRM all get the same 404, so addresses can't be
// probed.
import { query } from "../../core/db.js";
import { HttpError } from "../../core/http.js";
import { writeRefusal } from "../../core/billing/product-access.js";
import { read, write } from "../db.js";
import { SLUG, slugProblem } from "./rules.js";
import { pageOf, imagesOf, imageUrl } from "./settings.js";
import { hoursOf, openingOf } from "./hours.js";
import { suggestDelivery, rulesOf as deliveryRules } from "../shared/delivery.js";
import { rulesOf as bookingRules } from "../shared/booking.js";
import { customerFields } from "../shared/fields.js";
import { dayOf } from "../shared/time.js";

export const pageNotFound = () => new HttpError(404, "Not found", { code: "not_found" });

/**
 * A page's write: its changes go to the host (so the modules hear of it, see afterWrite in
 * ../modules.js); the customer gets only the rest of the answer.
 */
export const pageWrite = async (ws, fn) => {
  const { changes, rev, ...out } = await write(ws.id, fn);
  return out;
};

// The one query that can't start from a workspace: it finds the workspace (crm_settings_public_slug).
// The whole workspace row: its products and its billing decide what the page may do.
const BY_SLUG = `SELECT w.* FROM crm_settings s JOIN workspaces w ON w.id = s.workspace_id
  WHERE (s.data->'settings'->'publicPage'->>'slug') = $1 AND (s.data->'settings'->'publicPage'->>'slug') <> ''`;

/** The workspace that has this address (its row: id, name, products, billing), or null. `q`: inside a write, its client's. */
export async function slugOwner(slug, q = query) {
  if (typeof slug !== "string" || !SLUG.test(slug)) return null;
  return (await q(BY_SLUG, [slug])).rows[0] || null;
}

/**
 * Whether an address can be this workspace's, for the settings tab before it saves:
 * { slug, free, problem: null | { code: "bad_slug" | "reserved_slug" | "slug_taken" } }.
 */
export async function checkSlug(workspaceId, slug) {
  let problem = slugProblem(slug);
  if (!problem && slug) {
    const owner = await slugOwner(slug);
    if (owner && owner.id !== workspaceId) problem = { code: "slug_taken" };
  }
  return { slug, free: !problem, problem };
}

/** The workspace behind a page's address, or the 404. Only a workspace with the CRM has pages. */
export async function workspaceOfPage(slug) {
  const ws = await slugOwner(slug);
  if (!ws || !(ws.products || []).includes("crm")) throw pageNotFound();
  return ws;
}

/**
 * The page settings when this part is open ("booking", "shop", or "any" for the page's front),
 * read from `cfg` inside the request's own transaction; else the 404.
 */
export function openPart(cfg, part) {
  const page = pageOf(cfg);
  const open = part === "any" ? page.on.booking || page.on.shop : page.on[part];
  if (!open) throw pageNotFound();
  return page;
}

/**
 * A page's writes (book, cancel, order) wait while the business's CRM is read-only (billed and not
 * paid for): the same decision as the team's writes (writeRefusal). A customer is told only that
 * it isn't available right now: 402 { code: "unavailable" }, nothing about the business's billing.
 */
export function needWritable(ws) {
  if (writeRefusal(ws, "crm")) throw new HttpError(402, "This isn't available right now.", { code: "unavailable" });
}

/** The 404 unless this part of the page is open: run by the router before a route reads its input. */
export const checkPart = (ws, part) => read(ws.id, async (q, cfg) => void openPart(cfg, part));

/**
 * The fields of a booking or an order the business needs a customer to fill ({ id, name, type,
 * options? }): the page asks for them. The others are the team's own.
 */
export const fieldsToAsk = (defs) => customerFields(defs).map(({ id, name, type, options }) => ({ id, name, type, ...(options ? { options } : {}) }));

/** GET /: what the page needs to draw itself. Nothing about the team, customers or stock. */
export const showFront = (ws) => read(ws.id, async (q, cfg) => front(ws, cfg, q));
const exactTime = ({ date, time }) => ({ date, time });
async function front(ws, cfg, q) {
  const page = openPart(cfg, "any");
  const { settings } = cfg.data;
  const images = imagesOf(cfg);
  const out = {
    name: ws.name,
    description: page.description,
    phone: page.phone,
    address: page.address,
    languages: page.languages,
    today: dayOf(cfg.now),
    now: cfg.now,
    pages: page.on,
    // The page's own pictures, on its API: "" when it has none.
    cover: imageUrl(page.slug, images.cover),
    logo: imageUrl(page.slug, images.logo),
    // Open now and until when, or when it opens next (hours.js): only times, nothing of the team.
    hours: openingOf(cfg.now, await hoursOf(q, cfg)),
  };
  if (page.on.booking) {
    const r = bookingRules({ settings });
    out.booking = { maxDays: r.maxDays, cancelUntil: r.cancelUntil, step: r.step };
  }
  if (page.on.shop) {
    const d = deliveryRules(settings.delivery);
    out.shop = {
      deliveryMethods: page.deliveryMethods.map((m) => ({ id: m.id, name: m.name, address: m.address, fee: m.fee })),
      paymentMethods: page.paymentMethods.map((m) => ({ id: m.id, name: m.name })),
      // The business's notes on closed days stay inside: the page shows the day as closed.
      delivery: { time: d.time, windows: d.windows, daysOff: d.daysOff, closed: d.closed.map((c) => c.date), sameDayUntil: d.sameDayUntil, prepMinutes: d.prepMinutes, maxDays: d.maxDays },
      first: suggestDelivery(settings.delivery, cfg.now, settings.dayStart),
      // The first exact time, whenever the business takes exact times (with windows too, in "both").
      firstTime: d.time === "windows" ? null : exactTime(suggestDelivery(settings.delivery, cfg.now, settings.dayStart, { exact: true })),
      fields: fieldsToAsk(cfg.data.fields.order),
    };
  }
  return out;
}
