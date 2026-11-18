// Importing a spreadsheet, in two calls, so nothing is ever written by itself:
// 1. preview: the file is read and checked against the workspace as it is now, and the answer says
//    what would happen (rows to add, rows to change, rows skipped with a reason and their row
//    number, the columns it recognised). Nothing is saved but the preview, kept with a token.
// 2. apply: the token applies exactly that preview. It works once, for 30 minutes, only for the
//    person who made it in the workspace it was made in. If the workspace changed meanwhile so the
//    same file would now do something else, nothing is saved (409 preview_stale): preview again.
import crypto from "node:crypto";
import multer from "multer";
import { z } from "zod";
import { HttpError } from "../../core/http.js";
import { query } from "../../core/db.js";
import { read, write, wall } from "../db.js";
import { bad, conflict } from "../errors.js";
import { same } from "../shared/index.js";
import { readSheet, SheetError } from "./xlsx.js";
import { recognise } from "./cells.js";
import { customerColumns, planCustomers, applyCustomers } from "./customers.js";
import { productColumns, planProducts, applyProducts } from "./products.js";

export const MAX_FILE = 5 * 1024 * 1024;
export const MAX_ROWS = 10000;
const MAX_COLUMNS = 100;
const MAX_CELL = 5000;
// Characters kept from the whole sheet: a file of 10,000 full rows of customers is well under it.
export const MAX_TEXT = 10000000;
const MINUTES = 30;

// What each kind of import needs: its columns, at least one of `needs` (else nothing can be matched or added), how to plan and write.
const KINDS = {
  customers: { columns: customerColumns, needs: ["id", "name", "phone"], plan: planCustomers, apply: (c, cfg, q, user, plan) => applyCustomers(c, cfg, q, plan) },
  products: { columns: productColumns, needs: ["id", "product", "sku"], plan: planProducts, apply: applyProducts },
};
export const IMPORT_KINDS = Object.keys(KINDS);

const parser = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE, files: 1, fields: 0 } });
/** Reads the one `file` of a multipart request. */
export function acceptFile(req, res, next) {
  parser.single("file")(req, res, (err) => {
    if (err?.code === "LIMIT_FILE_SIZE") return next(new HttpError(413, "A spreadsheet can be up to 5 MB.", { code: "file_too_large", max: MAX_FILE }));
    if (err) return next(bad("Send one spreadsheet as `file`.", "bad_file"));
    next();
  });
}

const hash = (token) => crypto.createHash("sha256").update(token).digest("hex");

/** What a preview answers: counts and rows, without the values it keeps for the write. */
function summary(kind, table, plan) {
  const add = plan.add.map((a) => ({ row: a.row, name: a.values.name, ...(kind === "products" ? { sku: a.values.sku } : {}) }));
  const update = plan.update.map(({ row, name, values, variant, product, ...ids }) => ({ row, ...ids, name, changes: Object.keys({ ...values, ...product, ...variant }) }));
  return { kind, rows: table.rows.length, columns: table.columns, ignored: table.ignored, add, update, unchanged: plan.unchanged.length, skip: plan.skip };
}

/** Step 1: reads the file, answers what importing it would do, and keeps that as a preview. */
export async function previewImport(workspace, user, kind, file) {
  if (!file) throw bad("Send the spreadsheet as `file`.", "bad_file");
  let rows;
  try {
    rows = readSheet(file.buffer, { maxRows: MAX_ROWS + 1, maxCols: MAX_COLUMNS, maxCell: MAX_CELL, maxText: MAX_TEXT });
  } catch (e) {
    if (!(e instanceof SheetError)) throw e;
    if (e.code === "too_many_rows") throw new HttpError(413, `A spreadsheet can have up to ${MAX_ROWS} rows.`, { code: "too_many_rows", max: MAX_ROWS });
    if (e.code === "too_much_text") throw new HttpError(413, "This spreadsheet holds more text than an import can take.", { code: "too_much_text", max: MAX_TEXT });
    throw bad("This is not an .xlsx spreadsheet.", "bad_file");
  }
  const how = KINDS[kind];
  const { table, plan, timezone } = await read(workspace.id, async (q, cfg) => {
    const table = recognise(rows, how.columns(cfg));
    if (!table.columns.some((c) => how.needs.includes(c.key))) throw bad("No column of the first row is one the import knows.", "no_columns", { needs: how.needs });
    if (!table.rows.length) throw bad("The spreadsheet has no rows under its header.", "no_rows");
    return { table, plan: await how.plan(q, cfg, table), timezone: cfg.timezone };
  });
  const token = crypto.randomBytes(24).toString("base64url");
  await query("DELETE FROM crm_imports WHERE workspace_id = $1 AND expires_at < now() - interval '1 day'", [workspace.id]);
  const { rows: saved } = await query(
    `INSERT INTO crm_imports (workspace_id, user_id, token_hash, kind, sheet, plan, expires_at) VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7))
     RETURNING ${wall("expires_at", "$8")} AS "expiresAt"`,
    [workspace.id, user.id, hash(token), kind, JSON.stringify(table), JSON.stringify(plan), MINUTES, timezone]
  );
  return { token, expiresAt: saved[0].expiresAt, ...summary(kind, table, plan) };
}

export const applySchema = z.object({ token: z.string().min(16).max(100) }).strict();

/** Step 2: applies a preview, exactly as it was answered. */
export function applyImport(workspace, user, { token }) {
  return write(workspace.id, async (c, cfg, q) => {
    const { rows } = await q(
      `SELECT id, user_id, kind, sheet, plan, used_at IS NOT NULL AS used, expires_at < now() AS expired FROM crm_imports
        WHERE workspace_id = $1 AND token_hash = $2 FOR UPDATE`,
      [cfg.workspaceId, hash(token)]
    );
    const preview = rows[0];
    // Another person's preview, or another workspace's, reads as one that doesn't exist.
    if (!preview || preview.user_id !== user.id) throw new HttpError(404, "This preview doesn't exist.", { code: "preview_not_found" });
    if (preview.used) throw conflict("This preview was already applied.", "preview_used");
    if (preview.expired) throw new HttpError(410, "This preview has expired. Upload the file again.", { code: "preview_expired" });
    const how = KINDS[preview.kind];
    const plan = await how.plan(q, cfg, preview.sheet);
    if (!same(JSON.parse(JSON.stringify(plan)), preview.plan)) throw conflict("The data changed since the preview. Upload the file again.", "preview_stale");
    await q("UPDATE crm_imports SET used_at = now() WHERE workspace_id = $1 AND id = $2", [cfg.workspaceId, preview.id]);
    return { kind: preview.kind, ...(await how.apply(c, cfg, q, user, plan)) };
  });
}
