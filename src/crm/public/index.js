// Public pages, as the CRM host sees them (a module, see ../modules.js): their own settings key
// (settings.publicPage, checked by PUT /settings through `settingsShape`, its address kept by one
// workspace through `checkSettings`) and one route for the settings tab. They own no snapshot keys.
// The pages' API itself is page-routes.js, mounted outside /w/:wid by src/app.js.
import { Router } from "express";
import { z } from "zod";
import { wrap } from "../../core/http.js";
import { validate } from "../../core/validate.js";
import { requireRole } from "../../core/workspaces/access.js";
import { asQ } from "../db.js";
import { conflict } from "../errors.js";
import { checkSlug, slugOwner } from "./pages.js";

export { settingsShape } from "./settings.js";
export const keys = [];
export const router = Router({ mergeParams: true });
const slugQuery = z.object({ slug: z.string().max(40) }).strict();

// GET /w/:wid/crm/public/slug?slug=x (admins): whether the settings tab may save this address.
router.get("/public/slug", requireRole("admin"), validate(slugQuery, "query"), wrap(async (req, res) => res.json(await checkSlug(req.workspace.id, req.valid.slug))));

/**
 * Before settings are saved: a page's new address must not be another workspace's (409 slug_taken).
 * Saves of one address run one after another (a lock on the address until the save commits), so
 * of several businesses taking it at once one gets it and the others hear slug_taken, the code the
 * address check answers, instead of meeting the unique index.
 */
export async function checkSettings(c, cfg, next) {
  const slug = next.settings?.publicPage?.slug;
  if (!slug || slug === cfg.data.settings.publicPage?.slug) return;
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`crm_public_slug:${slug}`]);
  const owner = await slugOwner(slug, asQ(c));
  if (owner && owner.id !== cfg.workspaceId) throw conflict("Another business has this address.", "slug_taken");
}
