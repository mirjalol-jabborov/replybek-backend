// Product pictures. A product's `image` is a path: a static one the app serves ("/products/x.jpg",
// as in the demo) or one uploaded here, stored with the same storage the inbox's attachments use
// (src/core/storage.js) and served back only to the workspace's own people.
// Each upload has a row in crm_product_images. A product may show an uploaded picture only while
// that row is there, and the row goes before the file does, under the workspace's write lock: so
// no product can end up showing a file that was removed.
import crypto from "node:crypto";
import multer from "multer";
import { HttpError, notFound } from "../../core/http.js";
import { putFile, removeFile } from "../../core/storage.js";
import { widthOf, pictureAt, removeWithCopies, cacheFor } from "../../core/thumbs.js";
import { query } from "../../core/db.js";
import { write, isUuid } from "../db.js";
import { storeChanges } from "./rows.js";

// A picture is identified by its first bytes, never by its name or what the browser calls it.
const bytes = (b, from, to) => b.subarray(from, to).toString("latin1");
const KINDS = [
  ["jpg", "image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["png", "image/png", (b) => bytes(b, 0, 8) === "\x89PNG\r\n\x1a\n"],
  ["webp", "image/webp", (b) => bytes(b, 0, 4) === "RIFF" && bytes(b, 8, 12) === "WEBP"],
  ["gif", "image/gif", (b) => /^GIF8[79]a$/.test(bytes(b, 0, 6))],
];
const MAX_IMAGE = 5 * 1024 * 1024;
const parser = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE, files: 1, fields: 2 } });
/** Reads the one `file` of a multipart request. */
export function acceptImage(req, res, next) {
  parser.single("file")(req, res, (err) => {
    if (err?.code === "LIMIT_FILE_SIZE") return next(new HttpError(413, "A picture can be up to 5 MB.", { code: "image_too_large" }));
    if (err) return next(new HttpError(400, "Send one picture as `file`.", { code: "bad_image" }));
    next();
  });
}

const NAME = /^[0-9a-f-]{36}\.(jpg|png|webp|gif)$/;
const keyOf = (workspaceId, name) => `crm/${workspaceId}/products/${name}`;
const pathOf = (workspaceId, name) => `/w/${workspaceId}/crm/products/images/${name}`;
/** The file name of a picture this workspace uploaded, or null for a static path (or anything else). */
export const uploadedName = (workspaceId, path) => {
  const prefix = pathOf(workspaceId, "");
  return typeof path === "string" && path.startsWith(prefix) && NAME.test(path.slice(prefix.length)) ? path.slice(prefix.length) : null;
};
const gone = () => new HttpError(400, "This picture is no longer there. Upload it again.", { code: "bad_image" });

/** Inside a product write: an uploaded picture must still be there to be shown. A static path is fine. */
export async function checkImage(c, workspaceId, path) {
  const name = uploadedName(workspaceId, path);
  if (!name) return;
  const { rows } = await c.query("SELECT 1 FROM crm_product_images WHERE workspace_id = $1 AND name = $2", [workspaceId, name]);
  if (!rows[0]) throw gone();
}

/**
 * Forgets these uploaded pictures, those no product shows, and removes their files. `stale`: also
 * every upload older than a day that no product took. The rows go in a write (the same lock as
 * every product write), and the files only after it commits: a write that wanted one
 * of them either came first (and the picture stays) or finds the row gone and is refused.
 */
async function forget(workspaceId, paths, { stale = false } = {}) {
  const names = paths.map((p) => uploadedName(workspaceId, p)).filter(Boolean);
  if (!names.length && !stale) return;
  const { removed } = await write(workspaceId, async (c) => {
    const { rows } = await c.query(
      `DELETE FROM crm_product_images i
        WHERE i.workspace_id = $1 AND (i.name = ANY($2::text[]) OR ($3 AND i.created_at < now() - interval '1 day'))
          AND NOT EXISTS (SELECT 1 FROM crm_products p WHERE p.workspace_id = i.workspace_id AND (p.image = $4 || i.name OR p.gallery @> jsonb_build_array($4 || i.name)))
        RETURNING i.name`,
      [workspaceId, names, stale, pathOf(workspaceId, "")]
    );
    // An upload from before its row existed (none in a new database) goes by its path alone.
    const legacy = names.filter((n) => !rows.some((r) => r.name === n));
    const { rows: shown } = legacy.length
      ? await c.query(
          `SELECT x.path AS image FROM unnest($2::text[]) AS x(path)
            WHERE EXISTS (SELECT 1 FROM crm_products p WHERE p.workspace_id = $1 AND (p.image = x.path OR p.gallery @> jsonb_build_array(x.path)))`,
          [workspaceId, legacy.map((n) => pathOf(workspaceId, n))]
        )
      : { rows: [] };
    return { removed: [...rows.map((r) => r.name), ...legacy.filter((n) => !shown.some((s) => s.image === pathOf(workspaceId, n)))] };
  });
  for (const name of removed) await removeWithCopies(keyOf(workspaceId, name)).catch(() => {});
}

/** After a write took this picture off a product: removed when it was uploaded and no product shows it now. */
export const dropUpload = (workspaceId, path) => forget(workspaceId, [path]).catch(() => {});
/** The same for several pictures at once (the photos a product write let go). */
export const dropUploads = (workspaceId, paths) => forget(workspaceId, paths).catch(() => {});

/**
 * Stores a picture and answers with its path: { image }. The path is on this API (the app puts
 * its API base in front), and goes into a product's `image` like any other path.
 */
export async function uploadImage(workspace, file) {
  if (!file) throw new HttpError(400, "Send one picture as `file`.", { code: "bad_image" });
  const kind = file.buffer.length >= 12 && KINDS.find(([, , test]) => test(file.buffer));
  if (!kind) throw new HttpError(415, "Send a JPG, PNG, WebP or GIF picture.", { code: "bad_image" });
  const name = `${crypto.randomUUID()}.${kind[0]}`;
  await putFile(keyOf(workspace.id, name), file.buffer, kind[1]);
  try {
    await query("INSERT INTO crm_product_images (workspace_id, name) VALUES ($1, $2)", [workspace.id, name]);
  } catch (e) {
    await removeFile(keyOf(workspace.id, name)).catch(() => {});
    throw e;
  }
  // Uploads that no product took within a day (the product was never saved) go now.
  await forget(workspace.id, [], { stale: true }).catch(() => {});
  return { image: pathOf(workspace.id, name) };
}

/**
 * Uploads a picture and makes it the product's. The picture it had, if it was uploaded, is removed.
 * `user`: who does it; the product in the answer has their branch's numbers when they are limited to one.
 */
export async function setProductImage(workspace, user, productId, file) {
  if (!isUuid(productId)) throw notFound("Product not found");
  const { image: path } = await uploadImage(workspace, file);
  try {
    const out = await write(workspace.id, async (c, cfg, q) => {
      const stored = (await c.query("SELECT image FROM crm_products WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [cfg.workspaceId, productId])).rows[0];
      if (!stored) throw notFound("Product not found");
      await c.query("UPDATE crm_products SET image = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2", [cfg.workspaceId, productId, path]);
      return { changes: await storeChanges(q, cfg, { productIds: [productId], branchId: user?.branchOnly }), image: path, old: stored.image };
    });
    const { old, ...body } = out;
    await dropUpload(workspace.id, old);
    return body;
  } catch (e) {
    await dropUpload(workspace.id, path);
    throw e;
  }
}

/**
 * Whether anyone may see this uploaded picture (a public page, a chat with the AI agent, which
 * Telegram fetches without a session): only while a product on sale that customers can order
 * shows it, as its main photo or one of the others. That is what the business offers anyone anyway.
 */
export async function shownToCustomers(workspaceId, name) {
  if (!NAME.test(String(name))) return false;
  const { rows } = await query(
    `SELECT 1 FROM crm_products p WHERE p.workspace_id = $1 AND (p.image = $2 OR p.gallery @> jsonb_build_array($2::text)) AND p.on_sale
        AND EXISTS (SELECT 1 FROM crm_variants v WHERE v.workspace_id = p.workspace_id AND v.product_id = p.id AND NOT v.archived) LIMIT 1`,
    [workspaceId, pathOf(workspaceId, name)]
  );
  return rows.length > 0;
}

/**
 * Sends an uploaded picture, with headers that stop a browser from reading it as anything else.
 * `w`: the request's `?w=`, for a smaller WebP copy (core/thumbs.js). `shared`: the picture is one
 * anyone may see (a shop page's, the AI agent's), so a CDN may keep it too; else only the viewer's
 * browser does. A name never changes, so either may keep it long.
 */
export async function sendImage(res, workspace, name, { w, shared = false, jpegUnlessWebp } = {}) {
  const width = widthOf(w);
  const kind = NAME.test(name) && KINDS.find(([ext]) => name.endsWith(`.${ext}`));
  // jpegUnlessWebp: the request's Accept, for a caller that may not take WebP (see bridge/media.js).
  const format = jpegUnlessWebp !== undefined && !/image\/webp/.test(jpegUnlessWebp || "") ? "jpeg" : "webp";
  const pic = kind && (await pictureAt(keyOf(workspace.id, name), width, format));
  if (!pic) throw notFound("Picture not found");
  res.set({ "Content-Type": pic.type || kind[1], "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": cacheFor(shared) });
  if (width && jpegUnlessWebp !== undefined) res.set("Vary", "Accept");
  res.end(pic.data);
}
