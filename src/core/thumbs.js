// Smaller copies of an uploaded picture, for the places that show it small (a list's thumbnail, a
// shop's grid). A route that sends a picture takes `?w=` from a fixed set of widths (WIDTHS); the
// copy is made the first time it is asked for, as WebP (same aspect, never wider than the original,
// no metadata), and stored next to the original as "<key>@w<width>.webp". After that it is sent
// from storage. A caller that can't take WebP (Telegram fetching a chat's photo) can ask for JPEG,
// stored as "<key>@w<width>.jpg". Whoever removes an original removes its copies too (removeWithCopies).
// Copies are made one at a time, with a limit on the pixels a picture may have, so a big upload
// can't take the server's memory.
import sharp from "sharp";
import { HttpError } from "./http.js";
import { getFile, putFile, removeFile } from "./storage.js";

/** The widths a copy can have. Anything wider is the original. */
export const WIDTHS = [96, 240, 480];
const MAX_PIXELS = 40_000_000; // 5 MB uploads are far smaller; a picture claiming more is refused, not decoded
sharp.cache(false);
sharp.concurrency(1);

/**
 * The width asked for in `?w=`: null for the original (no `w`, or one wider than any copy), else the
 * smallest allowed width at least as wide as asked. Anything that isn't a whole number is a 400.
 */
export function widthOf(w) {
  if (w === undefined || w === "") return null;
  if (typeof w !== "string" || !/^\d{1,5}$/.test(w) || Number(w) < 1) throw new HttpError(400, "`w` is a width in pixels.", { code: "bad_width" });
  const n = Number(w);
  return WIDTHS.find((x) => x >= n) ?? null;
}

const FORMATS = { webp: ["webp", "image/webp"], jpeg: ["jpg", "image/jpeg"] };
const copyKey = (key, width, format) => `${key}@w${width}.${FORMATS[format][0]}`;

// One copy is made at a time; a second ask for the same copy while it is being made waits for it.
let queue = Promise.resolve();
const making = new Map();

async function make(key, width, format) {
  const original = await getFile(key);
  if (!original) return null;
  try {
    // Turned the way the camera meant (the metadata itself is not kept), and never made wider.
    const img = sharp(original, { limitInputPixels: MAX_PIXELS, animated: false }).rotate().resize({ width, withoutEnlargement: true });
    const out = await (format === "jpeg" ? img.flatten({ background: "#ffffff" }).jpeg({ quality: 80, mozjpeg: true }) : img.webp({ quality: 78, effort: 4 })).toBuffer();
    await putFile(copyKey(key, width, format), out, FORMATS[format][1]);
    return out;
  } catch {
    return { original }; // a picture sharp can't read is sent as it is
  }
}

/**
 * The bytes to send for the picture stored at `key` at this width: { data, type }, or null when the
 * original isn't there. `width` null is the original itself (`type` is then the caller's).
 * `format`: "webp" (the default) or "jpeg".
 */
export async function pictureAt(key, width, format = "webp") {
  if (!width) {
    const data = await getFile(key);
    return data && { data, type: null };
  }
  const type = FORMATS[format][1];
  const id = copyKey(key, width, format);
  const stored = await getFile(id);
  if (stored) return { data: stored, type };
  if (!making.has(id)) {
    const run = queue.then(() => make(key, width, format));
    queue = run.catch(() => {});
    making.set(id, run);
    run.finally(() => making.delete(id)).catch(() => {});
  }
  const made = await making.get(id);
  if (!made) return null;
  return made.original ? { data: made.original, type: null } : { data: made, type };
}

/** Removes a stored picture and every copy made of it. A missing one is fine. */
export async function removeWithCopies(key) {
  await Promise.all([removeFile(key), ...WIDTHS.flatMap((w) => Object.keys(FORMATS).map((f) => removeFile(copyKey(key, w, f))))]);
}

/** Cache-Control for a picture: anyone's (a shop page's, kept by a CDN too) or only the viewer's browser. */
export const cacheFor = (shared) => (shared ? "public, max-age=86400, s-maxage=604800" : "private, max-age=31536000, immutable");
