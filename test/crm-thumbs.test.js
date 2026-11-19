// Smaller copies of uploaded pictures (src/core/thumbs.js): `?w=` on every route that sends a
// product photo or a page picture. A copy is WebP, made once and kept next to the original, goes
// with it, and is shown to exactly whom the original is shown. Shop pictures may sit in a CDN;
// the team's stay private.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { crmOwner, owner, browser, query, base } from "./helpers/setup.js";
import { widthOf, WIDTHS } from "../src/core/thumbs.js";

const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
let seq = 0;
const PUBLIC = "public, max-age=86400, s-maxage=604800";
const PAGE = { booking: false, shop: true, description: "Flowers", phone: "71 200 00 00", address: "Tashkent", languages: ["uz", "ru", "en"], paymentMethods: ["cash"], deliveryMethods: ["pickup"] };

/** A photo-like JPEG (noise, so it doesn't shrink to nothing) with EXIF on it. */
const photo = (width = 800, height = 600) =>
  sharp(Buffer.from(Array.from({ length: width * height * 3 }, (_, i) => (i * 7919 + ((i / 3) | 0) * 31) % 251)), { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .withExif({ IFD0: { Copyright: "Secret camera owner" } })
    .toBuffer();
const form = (buffer, type = "image/jpeg", name = "a.jpg") => {
  const f = new FormData();
  f.append("file", new Blob([buffer], { type }), name);
  return f;
};
/** The raw answer: status, headers, bytes. */
const get = async (p, headers = {}) => {
  const r = await fetch(base + p, { headers });
  return { status: r.status, headers: r.headers, bytes: Buffer.from(await r.arrayBuffer()) };
};
const stored = (ws, rel) => path.join(process.env.UPLOAD_DIR, "crm", ws.id, rel);

/** A CRM workspace with the Store and its shop page on. */
async function shop() {
  const o = await crmOwner();
  const slug = `thumbs-${++seq}-${process.pid}`;
  ok(await o.b.call("PUT", `${o.crm}/settings`, { modules: { booking: false, store: true }, settings: { publicPage: { ...PAGE, slug } } }));
  const upload = async (buffer) => ok(await o.b.call("POST", `${o.crm}/products/images`, form(buffer || (await photo()))), 201).image;
  const product = async (over) => (await o.b.call("POST", `${o.crm}/products`, { name: "Roses", sku: `R${++seq}`, price: 40000, opening: 5, ...over })).body.changes.set.products[0];
  const cookie = { Cookie: o.b.cookie };
  return { ...o, slug, upload, product, cookie, pub: `/public/crm/${slug}` };
}

test("widths: only the fixed set; a wider ask is the original, anything that isn't a width is refused", () => {
  assert.deepEqual(WIDTHS, [96, 240, 480]);
  assert.equal(widthOf(undefined), null);
  assert.equal(widthOf("96"), 96);
  assert.equal(widthOf("40"), 96);
  assert.equal(widthOf("100"), 240);
  assert.equal(widthOf("480"), 480);
  assert.equal(widthOf("481"), null);
  assert.equal(widthOf("4000"), null);
  for (const bad of ["0", "-5", "abc", "96px", "1.5", "123456", ["96", "240"]]) assert.throws(() => widthOf(bad), (e) => e.status === 400, String(bad));
});

test("team route: a smaller WebP copy, kept in storage next to the original, no metadata, private", async () => {
  const x = await shop();
  const original = await photo();
  const image = await x.upload(original);
  const name = image.split("/").pop();

  const full = await get(image, x.cookie);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "image/jpeg");
  assert.equal(full.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(full.bytes.length, original.length);

  const small = await get(`${image}?w=96`, x.cookie);
  assert.equal(small.status, 200);
  assert.equal(small.headers.get("content-type"), "image/webp");
  assert.equal(small.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(small.headers.get("x-content-type-options"), "nosniff");
  const meta = await sharp(small.bytes).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ["webp", 96, 72], "the same aspect");
  assert.equal(meta.exif, undefined, "no metadata");
  assert.ok(small.bytes.length * 10 < original.length, `${small.bytes.length} vs ${original.length}`);
  assert.ok(fs.existsSync(stored(x.ws, `products/${name}@w96.webp`)), "stored next to the original");

  // Made once: the stored copy is what is sent after.
  fs.writeFileSync(stored(x.ws, `products/${name}@w96.webp`), small.bytes);
  const again = await get(`${image}?w=96`, x.cookie);
  assert.deepEqual(again.bytes, small.bytes);

  // In between widths go up to the next one; wider than any copy is the original; junk is a 400.
  assert.equal((await sharp((await get(`${image}?w=200`, x.cookie)).bytes).metadata()).width, 240);
  assert.equal((await get(`${image}?w=1200`, x.cookie)).headers.get("content-type"), "image/jpeg");
  assert.equal((await get(`${image}?w=abc`, x.cookie)).status, 400);
  assert.equal((await get(`${image}?w=0`, x.cookie)).status, 400);
  // Only the workspace's people.
  assert.equal((await get(`${image}?w=96`)).status, 401);
  const other = await crmOwner();
  assert.notEqual((await get(`${image}?w=96`, { Cookie: other.b.cookie })).status, 200);
});

test("never made wider than the original", async () => {
  const x = await shop();
  const image = await x.upload(await photo(200, 100));
  const r = await get(`${image}?w=480`, x.cookie);
  assert.equal(r.headers.get("content-type"), "image/webp");
  const meta = await sharp(r.bytes).metadata();
  assert.deepEqual([meta.width, meta.height], [200, 100]);
});

test("shop page: copies follow the original's rule (only while a product on sale shows it), and may sit in a CDN", async () => {
  const x = await shop();
  const [main, more] = [await x.upload(), await x.upload()];
  const p = await x.product({ images: [main, more] });
  const listed = ok(await browser().call("GET", `${x.pub}/products`)).products.find((v) => v.id === p.id);
  const [a, b] = listed.images;
  for (const src of [a, b]) {
    const r = await get(`${src}?w=240`);
    assert.equal(r.status, 200, src);
    assert.equal(r.headers.get("content-type"), "image/webp");
    assert.equal(r.headers.get("cache-control"), PUBLIC);
    assert.equal((await sharp(r.bytes).metadata()).width, 240);
    assert.equal((await get(src)).headers.get("cache-control"), PUBLIC, "the original too");
  }
  // Off sale: neither the copy (already made) nor the original.
  ok(await x.b.call("PUT", `${x.crm}/products/${p.id}`, { onSale: false }));
  assert.equal((await get(`${a}?w=240`)).status, 404);
  assert.equal((await get(`${a}?w=96`)).status, 404);
  assert.equal((await get(a)).status, 404);
  ok(await x.b.call("PUT", `${x.crm}/products/${p.id}`, { onSale: true }));
  assert.equal((await get(`${a}?w=240`)).status, 200);
  // A picture no product shows (just uploaded) has no copy for the page either.
  const loose = (await x.upload()).split("/").pop();
  assert.equal((await get(`${x.pub}/images/${loose}?w=96`)).status, 404);
  assert.equal((await get(`${x.pub}/images/${loose}?w=junk`)).status, 404, "a hidden picture is the 404 whatever is asked");
  // The shop part off: the page's 404.
  ok(await x.b.call("PUT", `${x.crm}/settings`, { settings: { publicPage: { ...PAGE, shop: false, slug: x.slug } } }));
  assert.equal((await get(`${a}?w=240`)).status, 404);
});

test("copies go with the original: a photo taken out, a replaced main photo, a deleted product", async () => {
  const x = await shop();
  const copies = (name) => fs.readdirSync(path.dirname(stored(x.ws, `products/${name}`))).filter((f) => f.startsWith(name));
  const make = async (image) => {
    for (const w of [96, 240, 480]) assert.equal((await get(`${image}?w=${w}`, x.cookie)).status, 200);
    const name = image.split("/").pop();
    assert.equal(copies(name).length, 4, "the original and three copies");
    return name;
  };
  const [a, b] = [await x.upload(), await x.upload()];
  const p = await x.product({ images: [a, b] });
  const [na, nb] = [await make(a), await make(b)];

  // Taken out of the gallery.
  ok(await x.b.call("PUT", `${x.crm}/products/${p.id}`, { images: [a] }));
  assert.deepEqual(copies(nb), []);
  assert.equal(copies(na).length, 4);

  // A new main photo through POST /products/:id/image replaces it.
  ok(await x.b.call("POST", `${x.crm}/products/${p.id}/image`, form(await photo())));
  assert.deepEqual(copies(na), []);

  // A deleted product.
  const c = await x.upload();
  const q = await x.product({ image: c, opening: 0 });
  const nc = await make(c);
  ok(await x.b.call("DELETE", `${x.crm}/products/${q.id}`));
  assert.deepEqual(copies(nc), []);

  // An upload no product took, removed with the day's cleanup.
  const d = await x.upload();
  const nd = await make(d);
  await query("UPDATE crm_product_images SET created_at = now() - interval '2 days' WHERE name = $1", [nd]);
  await x.upload();
  assert.deepEqual(copies(nd), []);
});

test("page pictures: a smaller copy on the page (public) and in the settings preview (private); replaced, its copies go", async () => {
  const x = await shop();
  const cover = ok(await x.b.call("POST", `${x.crm}/public/images/cover`, form(await photo())), 201).pageImages.cover;
  const front = ok(await browser().call("GET", `${x.pub}/`));
  const page = await get(`${front.cover}?w=480`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "image/webp");
  assert.equal(page.headers.get("cache-control"), PUBLIC);
  const preview = await get(`${x.crm}/public/images/${cover}?w=96`, x.cookie);
  assert.equal(preview.headers.get("content-type"), "image/webp");
  assert.match(preview.headers.get("cache-control"), /^private, /);
  assert.equal((await get(`${front.cover}?w=nope`)).status, 400);
  const dir = path.join(process.env.UPLOAD_DIR, "crm", x.ws.id, "public");
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith(cover)).length, 3);
  ok(await x.b.call("DELETE", `${x.crm}/public/images/cover`));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith(cover)), []);
});

test("the AI agent's photos: 480 px; WebP for a browser, JPEG for Telegram's fetcher; private, as the answer depends on Accept", async () => {
  process.env.PUBLIC_API_URL = base;
  const o = await owner("Dilnoza Rahimova", "Gulzor");
  const w = `/w/${o.ws.id}`;
  const agent = ok(await o.b.call("POST", `${w}/agents`, { name: "Gulzor AI" }), 201);
  ok(await o.b.call("POST", `${w}/agents/${agent.id}/publish`));
  ok(await o.b.call("POST", `${w}/products`, { add: "crm" }));
  ok(await o.b.call("PUT", `${w}/crm/settings`, { modules: { booking: false, store: true }, settings: { aiConnected: true } }));
  const image = ok(await o.b.call("POST", `${w}/crm/products/images`, form(await photo())), 201).image;
  ok(await o.b.call("POST", `${w}/crm/products`, { name: "Red roses", price: 100000, opening: 5, image }), 201);
  const { imageUrl } = await import("../src/bridge/media.js");
  const url = imageUrl({ workspace: { id: o.ws.id }, agentKey: agent.public_key }, image);
  assert.equal(url, `${base}/widget/${agent.public_key}/crm-media/${image.split("/").pop()}?w=480`);
  const path_ = url.slice(base.length);

  const browserGot = await get(path_, { Accept: "image/avif,image/webp,*/*" });
  assert.equal(browserGot.status, 200);
  assert.equal(browserGot.headers.get("content-type"), "image/webp");
  assert.equal(browserGot.headers.get("vary"), "Accept");
  assert.match(browserGot.headers.get("cache-control"), /^private, /);
  const tg = await get(path_, { Accept: "*/*" });
  assert.equal(tg.headers.get("content-type"), "image/jpeg");
  const meta = await sharp(tg.bytes).metadata();
  assert.deepEqual([meta.format, meta.width, meta.exif], ["jpeg", 480, undefined]);
  // Off sale: not shown, copy or not.
  const id = (await query("SELECT id FROM crm_products WHERE workspace_id = $1", [o.ws.id])).rows[0].id;
  ok(await o.b.call("PUT", `${w}/crm/products/${id}`, { onSale: false }));
  assert.equal((await get(path_, { Accept: "image/webp" })).status, 404);
});
