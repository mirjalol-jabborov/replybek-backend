// The public page's own pictures: a cover photo across its top and the business's logo. An admin
// uploads or removes each one in the "Public pages" settings tab, as its own action, the way a
// product photo is uploaded (Store's acceptImage: one `file`, up to 5 MB, the same refusal codes:
// 400 bad_image, 415 bad_image, 413 image_too_large). A picture is told by its first bytes.
// They are kept in settings.pageImages ({ cover, logo }: a stored file's name, or ""), a key that
// PUT /settings does not take, so saving the tab's text fields can neither bring back nor lose one.
// The page shows them (GET /page-images/:name) only while it is on, and only the current ones.
import crypto from "node:crypto";
import { HttpError } from "../../core/http.js";
import { putFile, getFile, removeFile } from "../../core/storage.js";
import { read, write } from "../db.js";
import { acceptImage } from "../store/images.js";
import { openPart, pageNotFound } from "./pages.js";
import { imagesOf } from "./settings.js";

export { acceptImage };
/** The two pictures a page has. */
export const KINDS = ["cover", "logo"];

const bytes = (b, from, to) => b.subarray(from, to).toString("latin1");
const TYPES = [
  ["jpg", "image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["png", "image/png", (b) => bytes(b, 0, 8) === "\x89PNG\r\n\x1a\n"],
  ["webp", "image/webp", (b) => bytes(b, 0, 4) === "RIFF" && bytes(b, 8, 12) === "WEBP"],
  ["gif", "image/gif", (b) => /^GIF8[79]a$/.test(bytes(b, 0, 6))],
];
const NAME = /^(cover|logo)-[0-9a-f-]{36}\.(jpg|png|webp|gif)$/;
const keyOf = (workspaceId, name) => `crm/${workspaceId}/public/${name}`;

/**
 * Puts `name` (or "" to remove) in the page's `kind` slot, in a write; the file it replaces is
 * removed once that has committed. Answers { pageImages, changes } with the CRM's settings as
 * the app keeps them, so the settings tab shows the new picture at once.
 */
async function keep(workspace, kind, name) {
  const { view } = await import("../core/settings.js");
  const out = await write(workspace.id, async (c, cfg) => {
    const before = imagesOf(cfg);
    const pageImages = { ...before, [kind]: name };
    const data = { ...cfg.data, settings: { ...cfg.data.settings, pageImages } };
    await c.query("UPDATE crm_settings SET data = $2, updated_at = now() WHERE workspace_id = $1", [workspace.id, JSON.stringify(data)]);
    return { pageImages, old: before[kind], changes: { top: { settings: view(data, workspace, cfg.timezone).settings } } };
  });
  const { old, ...body } = out;
  if (old && old !== name) await removeFile(keyOf(workspace.id, old)).catch(() => {});
  return body;
}

/** POST /w/:wid/crm/public/images/:kind (multipart `file`): stores the picture and makes it the page's cover or logo. */
export async function uploadPageImage(workspace, kind, file) {
  if (!file) throw new HttpError(400, "Send one picture as `file`.", { code: "bad_image" });
  const type = file.buffer.length >= 12 && TYPES.find(([, , test]) => test(file.buffer));
  if (!type) throw new HttpError(415, "Send a JPG, PNG, WebP or GIF picture.", { code: "bad_image" });
  const name = `${kind}-${crypto.randomUUID()}.${type[0]}`;
  await putFile(keyOf(workspace.id, name), file.buffer, type[1]);
  try {
    return await keep(workspace, kind, name);
  } catch (e) {
    await removeFile(keyOf(workspace.id, name)).catch(() => {});
    throw e;
  }
}

/** DELETE /w/:wid/crm/public/images/:kind: the page goes without it. */
export const removePageImage = (workspace, kind) => keep(workspace, kind, "");

/**
 * GET /public/crm/:slug/page-images/:name: the page's current cover or logo, while the page is on
 * (`forPage`). Anything else, a replaced picture too, is the page's 404. The settings tab's preview
 * (GET /w/:wid/crm/public/images/:name, the workspace's people) shows them whether the page is on or not.
 * The headers are the product pictures' own (Store's sendImage): a picture's name never changes, so
 * the viewer's browser may keep it.
 */
export async function sendPageImage(res, ws, name, { forPage = true } = {}) {
  const current = Object.values(await read(ws.id, async (q, cfg) => (forPage && openPart(cfg, "any"), imagesOf(cfg))));
  const type = NAME.test(String(name)) && current.includes(name) && TYPES.find(([ext]) => name.endsWith(`.${ext}`));
  const data = type && (await getFile(keyOf(ws.id, name)));
  if (!data) throw pageNotFound();
  res.set({ "Content-Type": type[1], "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "private, max-age=31536000, immutable" });
  res.end(data);
}
