// Excel export and import, mounted at /w/:wid/crm. Admins and the owner only.
//   GET  /export/customers.xlsx?lang            GET /export/products.xlsx?lang
//   GET  /export/bookings.xlsx?from&to&branch?&lang   GET /export/orders.xlsx?from&to&branch?&lang
//   POST /import/customers, /import/products     multipart `file`: the preview (see imports.js)
//   POST /import/apply { token }                 applies a preview
import { Router } from "express";
import { wrap } from "../../core/http.js";
import { validate } from "../../core/validate.js";
import { requireRole } from "../../core/workspaces/access.js";
import { exportSchema, spanSchema, exportBook, EXPORTS } from "./exports.js";
import { acceptFile, previewImport, applyImport, applySchema, IMPORT_KINDS } from "./imports.js";
import { LANGUAGES } from "./words.js";

export const router = Router({ mergeParams: true });
const admin = requireRole("admin");
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** The language asked for, else the person's own, else English. */
const languageOf = (req) => req.valid.lang || (LANGUAGES.includes(req.user.lang) ? req.user.lang : "en");

for (const what of EXPORTS) {
  const schema = what === "bookings" || what === "orders" ? spanSchema : exportSchema;
  router.get(`/export/${what}.xlsx`, admin, validate(schema, "query"), wrap(async (req, res) => {
    const { file, data } = await exportBook(req.workspace.id, what, req.valid, languageOf(req));
    res.set({ "Content-Type": XLSX, "Content-Disposition": `attachment; filename="${file}"`, "Cache-Control": "no-store" }).send(data);
  }));
}

for (const kind of IMPORT_KINDS) {
  router.post(`/import/${kind}`, admin, acceptFile, wrap(async (req, res) => res.json(await previewImport(req.workspace, req.user, kind, req.file))));
}
router.post("/import/apply", admin, validate(applySchema), wrap(async (req, res) => res.json(await applyImport(req.workspace, req.user, req.valid))));
