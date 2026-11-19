// The Store module through its API: products with variants and pictures, the stock ledger, orders
// through the workspace's own steps, delivery rules, money, roles, tenancy, the race for the last
// item and live updates. The pure rules have their own file (crm-shared-store.test.js).
import assert from "node:assert/strict";
import { test } from "node:test";
import { owner, crmOwner, teammate, browser, base, query } from "./helpers/setup.js";
import { addDays, nowIn, weekday } from "../src/crm/shared/time.js";
import { LEFT_CAP } from "../src/crm/shared/store.js";
import { createOrder } from "../src/crm/store/index.js";

const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const snap = async (o, only) => ok(await o.b.call("GET", `${o.crm}/snapshot${only ? `?only=${only}` : ""}`));
const settings = async (o, body) => ok(await o.b.call("PUT", `${o.crm}/settings`, body));
const product = async (o, body) => ok(await o.b.call("POST", `${o.crm}/products`, { name: "Roses", sku: `SKU${Math.random().toString(36).slice(2, 9)}`, price: 100000, cost: 60000, lowAt: 2, ...body }), 201).changes.set.products[0];
const customer = async (o, name = "Madina") => ok(await o.b.call("POST", `${o.crm}/customers`, { name }), 201).id;
const order = async (o, body, status = 201) => ok(await o.b.call("POST", `${o.crm}/orders`, { delivery: { type: "pickup" }, ...body }), status);
const step = (o, id, to, extra) => o.b.call("POST", `${o.crm}/orders/${id}/step`, { to, ...extra });
const one = async (o, key, id) => (await snap(o, key))[key].find((x) => x.id === id);
const stockOf = async (o, id) => {
  const p = await one(o, "products", id);
  return [p.stock, p.reserved];
};
const rules = (r) => ({ status: r.status, code: r.body?.code, hard: r.body?.hard, soft: r.body?.soft });

/** The cached counters must be the ledger added up, for every variant, and never out of bounds. */
async function ledgerHolds(o) {
  const { rows } = await query(
    `SELECT v.id, COALESCE(s.on_hand, 0)::float8 AS on_hand, COALESCE(s.reserved, 0)::float8 AS reserved,
            COALESCE(sum(m.qty) FILTER (WHERE m.type NOT IN ('reserve', 'release')), 0)::float8 AS ledger_on_hand,
            COALESCE(sum(m.qty) FILTER (WHERE m.type IN ('reserve', 'release')), 0)::float8 AS ledger_reserved
       FROM crm_variants v
       LEFT JOIN crm_stock s ON s.variant_id = v.id
       LEFT JOIN crm_stock_moves m ON m.variant_id = v.id
      WHERE v.workspace_id = $1 GROUP BY v.id, s.on_hand, s.reserved`,
    [o.ws.id]
  );
  assert.ok(rows.length, "there is stock to check");
  for (const r of rows) {
    assert.deepEqual([r.on_hand, r.reserved], [r.ledger_on_hand, r.ledger_reserved], `variant ${r.id}: counters = ledger`);
    assert.ok(r.on_hand >= 0 && r.reserved >= 0 && r.reserved <= r.on_hand, `variant ${r.id}: within bounds`);
  }
  // What accepted orders hold is exactly what the reserved count says.
  const { rows: held } = await query(
    `SELECT l.variant_id, sum(l.qty)::float8 AS qty FROM crm_order_lines l JOIN crm_orders o ON o.id = l.order_id
      WHERE o.workspace_id = $1 AND o.status = ANY($2::text[]) GROUP BY 1`,
    [o.ws.id, (await snap(o, "orderStages")).orderStages.filter((s) => s.kind === "reserved").map((s) => s.id)]
  );
  for (const r of rows) assert.equal(r.reserved, held.find((h) => h.variant_id === r.id)?.qty || 0, `variant ${r.id}: reserved = what orders hold`);
}

/** Opens an event stream like a browser does and collects what arrives. */
async function openStream(path, cookie) {
  const ctl = new AbortController();
  const res = await fetch(base + path, { headers: { "CF-Connecting-IP": "198.51.100.9", Cookie: cookie }, signal: ctl.signal });
  const events = [];
  (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (data !== undefined) events.push({ event: /^event: (.*)$/m.exec(block)?.[1] || "message", data: JSON.parse(data) });
        }
      }
    } catch {
      // aborted
    }
  })();
  return {
    events,
    async next(match, ms = 3000) {
      const end = Date.now() + ms;
      for (;;) {
        const hit = events.find(match);
        if (hit || Date.now() > end) return hit || null;
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    close: () => ctl.abort(),
  };
}

test("products: the demo's plain product, checks, edits and delete", async () => {
  const o = await crmOwner();
  await settings(o, { productCategories: [{ id: "roses", name: "Roses" }] });
  const made = ok(await o.b.call("POST", `${o.crm}/products`, { name: " Red roses ", sku: "RR-1", category: "roses", price: 120000, cost: 70000, unit: "pcs", lowAt: 5, image: "/products/roses.jpg", opening: 12 }), 201);
  const p = made.changes.set.products[0];
  assert.equal(made.id, p.id);
  assert.ok(made.rev > 1);
  const [v] = p.variants;
  assert.deepEqual(p, { id: p.id, name: "Red roses", sku: "RR-1", category: "roses", price: 120000, cost: 70000, unit: "pcs", image: "/products/roses.jpg", images: ["/products/roses.jpg"], description: "", onSale: true, stock: 12, reserved: 0, lowAt: 5, options: [], variants: [{ id: v.id, values: {}, sku: "RR-1", price: 120000, cost: 70000, stock: 12, reserved: 0, lowAt: 5 }], createdAt: p.createdAt });
  assert.match(p.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d$/);
  // Opening stock is a receipt in the ledger, written by the person who made the product.
  const [m] = made.changes.set.movements;
  assert.deepEqual(m, { id: m.id, productId: p.id, variantId: v.id, type: "receipt", qty: 12, at: m.at, by: "Kamola Yusupova", note: { en: "Opening stock", ru: "Начальный остаток", uz: "Boshlangʻich qoldiq" } });
  const db = await snap(o, "products,movements");
  assert.deepEqual(db.products, [p]);
  assert.deepEqual(db.movements, [m]);

  // The unit defaults to the first of the list; nothing else is needed but a name.
  const bare = ok(await o.b.call("POST", `${o.crm}/products`, { name: "Card" }), 201).changes.set.products[0];
  assert.deepEqual([bare.unit, bare.sku, bare.price, bare.stock, bare.variants.length], ["pcs", "", 0, 0, 1]);
  assert.equal((await snap(o, "products")).products[0].id, bare.id, "newest first");

  // Checks.
  const again = await o.b.call("POST", `${o.crm}/products`, { name: "Other", sku: "rr-1" });
  assert.deepEqual([again.status, again.body.code, again.body.sku], [409, "sku_taken", "RR-1"]);
  assert.equal((await o.b.call("POST", `${o.crm}/products`, { name: "X", unit: "nope" })).body.code, "bad_unit");
  assert.equal((await o.b.call("POST", `${o.crm}/products`, { name: "X", category: "nope" })).body.code, "bad_category");
  assert.equal((await o.b.call("POST", `${o.crm}/products`, { name: "X", image: "https://evil.example/x.jpg" })).status, 400);
  assert.equal((await o.b.call("POST", `${o.crm}/products`, { name: "X", price: 1.5 })).status, 400);
  assert.equal((await o.b.call("POST", `${o.crm}/products`, { sku: "A" })).status, 400);

  // Edits: details change, stock numbers never do here.
  assert.equal((await o.b.call("PUT", `${o.crm}/products/${p.id}`, { stock: 99 })).status, 400);
  const edited = ok(await o.b.call("PUT", `${o.crm}/products/${p.id}`, { name: "Red roses 60 cm", price: 130000, lowAt: 3, onSale: false })).changes.set.products[0];
  assert.deepEqual([edited.name, edited.price, edited.lowAt, edited.onSale, edited.stock, edited.sku, edited.variants[0].price], ["Red roses 60 cm", 130000, 3, false, 12, "RR-1", 130000]);
  assert.equal((await o.b.call("PUT", `${o.crm}/products/${bare.id}`, { sku: "RR-1" })).body.code, "sku_taken");
  ok(await o.b.call("PUT", `${o.crm}/products/${p.id}`, { sku: "RR-1" })); // its own SKU is not "taken"
  assert.equal((await o.b.call("PUT", `${o.crm}/products/${crypto.randomUUID()}`, { name: "X" })).status, 404);
  assert.equal((await o.b.call("PUT", `${o.crm}/products/nope`, { name: "X" })).status, 404);

  // Lists in use can't lose the item (core asks this module).
  const cats = await o.b.call("PUT", `${o.crm}/settings`, { productCategories: [] });
  assert.deepEqual([cats.status, cats.body.code, cats.body.list, cats.body.id, cats.body.count], [409, "in_use", "productCategories", "roses", 1]);
  const units = await o.b.call("PUT", `${o.crm}/settings`, { units: [{ id: "box", name: "box" }] });
  assert.deepEqual([units.status, units.body.code, units.body.id, units.body.count], [409, "in_use", "pcs", 2]);

  // Delete: admins only; a product with history stays.
  const mate = await teammate(o, "agent");
  assert.equal((await mate.b.call("DELETE", `${o.crm}/products/${bare.id}`)).status, 403);
  assert.deepEqual(ok(await o.b.call("DELETE", `${o.crm}/products/${bare.id}`)).changes, { del: { products: [bare.id] } });
  const kept = await o.b.call("DELETE", `${o.crm}/products/${p.id}`);
  assert.deepEqual([kept.status, kept.body.code, kept.body.movements, kept.body.stock], [409, "product_in_use", 1, 12]);
  assert.equal((await snap(o, "products")).products.length, 1);
  await ledgerHolds(o);
});

test("products with options: variants carry price, SKU and stock", async () => {
  const o = await crmOwner();
  const options = [{ id: "size", name: "Size", values: ["S", "M", "L"] }, { id: "color", name: "Colour", values: ["Red", "White"] }];
  const body = { name: "T-shirt", options, variants: [
    { values: { size: "S", color: "Red" }, sku: "TS-S-R", price: 90000, cost: 40000, lowAt: 1, opening: 3 },
    { values: { size: "M", color: "Red" }, sku: "TS-M-R", price: 95000, cost: 42000, lowAt: 2, opening: 5 },
    { values: { size: "M", color: "White" }, sku: "TS-M-W", price: 99000 },
  ] };
  const made = ok(await o.b.call("POST", `${o.crm}/products`, body), 201);
  const p = made.changes.set.products[0];
  // The product reads as its first variant, with stock added up.
  assert.deepEqual([p.sku, p.price, p.cost, p.stock, p.reserved, p.lowAt], ["TS-S-R", 90000, 40000, 8, 0, 3]);
  assert.deepEqual(p.options, options);
  assert.deepEqual(p.variants.map((v) => [v.values.size, v.values.color, v.sku, v.price, v.stock]), [["S", "Red", "TS-S-R", 90000, 3], ["M", "Red", "TS-M-R", 95000, 5], ["M", "White", "TS-M-W", 99000, 0]]);
  assert.equal(made.changes.set.movements.length, 2);
  const [s, m, w] = p.variants;

  // Variants must fit the options, and be different.
  const bad = async (variants, opts = options) => (await o.b.call("POST", `${o.crm}/products`, { name: "X", options: opts, variants })).body.code;
  assert.equal(await bad([{ values: { size: "XL", color: "Red" } }]), "variants_mismatch");
  assert.equal(await bad([{ values: { size: "S" } }]), "variants_mismatch");
  assert.equal(await bad([{ values: { size: "S", color: "Red" } }, { values: { size: "S", color: "Red" } }]), "variants_mismatch");
  assert.equal(await bad([{}, {}], []), "variants_mismatch");
  assert.equal((await o.b.call("POST", `${o.crm}/products`, { name: "X", options, variants: [{ values: { size: "S", color: "Red" }, sku: "a" }, { values: { size: "M", color: "Red" }, sku: "A" }] })).body.code, "sku_taken");
  // The product's own price can't be set while it has several.
  assert.equal((await o.b.call("PUT", `${o.crm}/products/${p.id}`, { price: 1 })).body.code, "variant_required");
  // Stock and orders need the variant named.
  assert.equal((await o.b.call("POST", `${o.crm}/stock/receive`, { lines: [{ productId: p.id, qty: 1 }] })).body.code, "variant_required");

  // The list of variants is replaced: one changed, one new (with opening stock), one left out.
  // White M was never stocked or sold: it is simply gone.
  const next = ok(await o.b.call("PUT", `${o.crm}/products/${p.id}`, { variants: [{ id: m.id, price: 97000 }, { id: s.id }, { values: { size: "L", color: "White" }, sku: "TS-L-W", price: 105000, opening: 2 }] })).changes;
  assert.deepEqual(next.set.products[0].variants.map((v) => [v.id === m.id ? "m" : v.id === s.id ? "s" : "new", v.price, v.stock]), [["m", 97000, 5], ["s", 90000, 3], ["new", 105000, 2]]);
  assert.equal(next.set.movements.length, 1);
  assert.equal((await query("SELECT count(*)::int AS n FROM crm_variants WHERE id = $1", [w.id])).rows[0].n, 0);
  assert.equal(next.set.products[0].price, 97000, "the first variant in the list is the one the product shows");

  // A variant with stock can't go; once it is empty it is put away, not deleted (the ledger points at it).
  const full = await o.b.call("PUT", `${o.crm}/products/${p.id}`, { variants: [{ id: m.id }] });
  assert.deepEqual([full.status, full.body.code, full.body.stock], [409, "variant_has_stock", 3]);
  ok(await o.b.call("POST", `${o.crm}/stock/write-off`, { variantId: s.id, qty: 3, reason: "damaged" }));
  const l = next.set.products[0].variants[2];
  const after = ok(await o.b.call("PUT", `${o.crm}/products/${p.id}`, { variants: [{ id: m.id }, { id: l.id }] })).changes.set.products[0];
  assert.deepEqual(after.variants.map((v) => [v.id, v.archived || false]), [[m.id, false], [l.id, false], [s.id, true]]);
  assert.deepEqual([after.stock, after.lowAt], [7, 2]);
  // A variant put away takes no new stock, by any way in.
  for (const [path, body] of [["receive", { lines: [{ variantId: s.id, qty: 1 }] }], ["count", { variantId: s.id, counted: 4 }]]) {
    const r = await o.b.call("POST", `${o.crm}/stock/${path}`, body);
    assert.deepEqual([r.status, r.body.code, r.body.variantId], [409, "variant_archived", s.id], path);
  }
  // Its SKU is free again, and it can't be stocked by mistake through the product.
  ok(await o.b.call("PUT", `${o.crm}/products/${p.id}`, { variants: [{ id: m.id, sku: "TS-S-R" }, { id: l.id }] }));
  assert.equal((await o.b.call("PUT", `${o.crm}/products/${p.id}`, { variants: [{ id: s.id }, { id: m.id }, { id: l.id }] })).body.code, "bad_variant");

  // Options can't change under variants that no longer fit.
  assert.equal((await o.b.call("PUT", `${o.crm}/products/${p.id}`, { options: [{ id: "size", name: "Size", values: ["S"] }] })).body.code, "variants_mismatch");
  ok(await o.b.call("PUT", `${o.crm}/products/${p.id}`, { options: [{ id: "size", name: "Size", values: ["M", "L", "XL"] }, options[1]] }));
  await ledgerHolds(o);

  // The database itself keeps "at least one variant".
  await assert.rejects(query("INSERT INTO crm_products (workspace_id, name) VALUES ($1, 'Empty')", [o.ws.id]), /at least one variant/);
  await assert.rejects(query("DELETE FROM crm_variants WHERE product_id = $1", [(await product(o)).id]), /at least one variant|violates foreign key/);
});

test("product pictures: upload, show, replace", async () => {
  const o = await crmOwner();
  const other = await crmOwner("Aziz", "Other shop");
  const p = await product(o);
  const png = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(40, 7)]);
  const form = (buf, name = "x.png") => {
    const f = new FormData();
    f.append("file", new Blob([buf]), name);
    return f;
  };
  // Upload first, save the path with the product later.
  const up = ok(await o.b.call("POST", `${o.crm}/products/images`, form(png)), 201);
  assert.match(up.image, new RegExp(`^/w/${o.ws.id}/crm/products/images/[0-9a-f-]{36}\\.png$`));
  const res = await fetch(base + up.image, { headers: { Cookie: o.b.cookie } });
  assert.deepEqual([res.status, res.headers.get("content-type"), res.headers.get("x-content-type-options")], [200, "image/png", "nosniff"]);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
  assert.equal(ok(await o.b.call("PUT", `${o.crm}/products/${p.id}`, { image: up.image })).changes.set.products[0].image, up.image);
  // Only this workspace's people see it.
  assert.equal((await fetch(base + up.image, { headers: { Cookie: other.b.cookie } })).status, 404);
  assert.equal((await fetch(base + up.image)).status, 401);
  assert.equal((await fetch(base + up.image.replace(o.ws.id, other.ws.id), { headers: { Cookie: other.b.cookie } })).status, 404);

  // Set a product's picture in one go: the old upload is removed.
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);
  const set = ok(await o.b.call("POST", `${o.crm}/products/${p.id}/image`, form(jpg, "photo.exe")));
  assert.match(set.image, /\.jpg$/);
  assert.equal(set.changes.set.products[0].image, set.image);
  assert.equal((await fetch(base + up.image, { headers: { Cookie: o.b.cookie } })).status, 404);
  assert.equal((await fetch(base + set.image, { headers: { Cookie: o.b.cookie } })).status, 200);

  // A picture taken off by an edit goes too, unless another product still shows it.
  const shared = ok(await o.b.call("POST", `${o.crm}/products/images`, form(png)), 201).image;
  const q2 = await product(o, { image: shared });
  ok(await o.b.call("PUT", `${o.crm}/products/${p.id}`, { image: shared }));
  ok(await o.b.call("PUT", `${o.crm}/products/${p.id}`, { image: "" }));
  assert.equal((await fetch(base + set.image, { headers: { Cookie: o.b.cookie } })).status, 404, "the one only p showed is removed");
  assert.equal((await fetch(base + shared, { headers: { Cookie: o.b.cookie } })).status, 200, "q2 still shows it");
  ok(await o.b.call("DELETE", `${o.crm}/products/${q2.id}`));
  assert.equal((await fetch(base + shared, { headers: { Cookie: o.b.cookie } })).status, 404, "deleting the last product that showed it removes it");

  // Not a picture, whatever it is called; no file; unknown product.
  assert.deepEqual([(await o.b.call("POST", `${o.crm}/products/images`, form(Buffer.from("<script>alert(1)</script>"), "x.png"))).status], [415]);
  assert.deepEqual(rules(await o.b.call("POST", `${o.crm}/products/images`, new FormData())), { status: 400, code: "bad_image", hard: undefined, soft: undefined });
  assert.equal((await o.b.call("POST", `${o.crm}/products/${crypto.randomUUID()}/image`, form(png))).status, 404);
  assert.equal((await o.b.call("GET", `${o.crm}/products/images/..%2F..%2Fsecret.png`)).status, 404);
  // The demo's static paths stay valid.
  assert.equal(ok(await o.b.call("PUT", `${o.crm}/products/${p.id}`, { image: "/products/8f2e4b26641260fa5c39.jpg" })).changes.set.products[0].image, "/products/8f2e4b26641260fa5c39.jpg");
});

test("product description: plain text with its line breaks, cleaned and limited", async () => {
  const o = await crmOwner();
  const made = ok(await o.b.call("POST", `${o.crm}/products`, { name: "Peonies", price: 1000, description: "  Pink peonies.\r\n\r\n\r\n\r\nComposition: 15 peonies\u202e, eucalyptus  \n<b>no html</b>  " }), 201).changes.set.products[0];
  assert.equal(made.description, "Pink peonies.\n\nComposition: 15 peonies, eucalyptus\n<b>no html</b>");
  assert.equal((await one(o, "products", made.id)).description, made.description, "in the snapshot too");
  const edited = ok(await o.b.call("PUT", `${o.crm}/products/${made.id}`, { description: "Line one\nLine two" })).changes.set.products[0];
  assert.equal(edited.description, "Line one\nLine two");
  assert.equal(ok(await o.b.call("PUT", `${o.crm}/products/${made.id}`, { name: "Peonies, pink" })).changes.set.products[0].description, "Line one\nLine two", "kept when not sent");
  assert.equal(ok(await o.b.call("PUT", `${o.crm}/products/${made.id}`, { description: "" })).changes.set.products[0].description, "");
  // Up to 2000 characters.
  ok(await o.b.call("PUT", `${o.crm}/products/${made.id}`, { description: "x".repeat(2000) }));
  assert.equal((await o.b.call("PUT", `${o.crm}/products/${made.id}`, { description: "x".repeat(2001) })).status, 400);
  assert.equal((await o.b.call("POST", `${o.crm}/products`, { name: "Y", description: 5 })).status, 400);
  // A product made before descriptions has "".
  assert.equal((await product(o)).description, "");
});

test("product gallery: up to 8 photos in order, the first is the main one; old products keep their one image", async () => {
  const o = await crmOwner();
  const other = await crmOwner("Aziz", "Other shop");
  const png = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(40, 7)]);
  const upload = async (b = o) => {
    const f = new FormData();
    f.append("file", new Blob([png]), "x.png");
    return ok(await b.b.call("POST", `${b.crm}/products/images`, f), 201).image;
  };
  const shown = async (path) => (await fetch(base + path, { headers: { Cookie: o.b.cookie } })).status;
  const [a, b, c] = [await upload(), await upload(), await upload()];
  const made = ok(await o.b.call("POST", `${o.crm}/products`, { name: "Bouquet", price: 1000, images: [a, b, c] }), 201).changes.set.products[0];
  assert.deepEqual([made.image, made.images], [a, [a, b, c]]);
  assert.deepEqual((await one(o, "products", made.id)).images, [a, b, c], "in the snapshot");
  // Reordered: the new first is the main one.
  const put = (body) => o.b.call("PUT", `${o.crm}/products/${made.id}`, body);
  let p = ok(await put({ images: [c, a, b] })).changes.set.products[0];
  assert.deepEqual([p.image, p.images], [c, [c, a, b]]);
  // `image` alone changes only the main photo, as before galleries; the others stay.
  const d = await upload();
  p = ok(await put({ image: d })).changes.set.products[0];
  assert.deepEqual(p.images, [d, a, b]);
  assert.equal(await shown(c), 404, "the main photo it replaced is removed");
  // Making a photo of the gallery the main one moves it, never shows it twice.
  p = ok(await put({ image: b })).changes.set.products[0];
  assert.deepEqual(p.images, [b, a]);
  assert.equal(await shown(d), 404);
  // An empty main photo makes the next one the main one.
  p = ok(await put({ image: "" })).changes.set.products[0];
  assert.deepEqual([p.image, p.images], [a, [a]]);
  assert.equal(await shown(b), 404);
  // A photo taken out of the gallery is removed unless another product shows it (as its main photo or in its gallery).
  const [e, f] = [await upload(), await upload()];
  const twin = ok(await o.b.call("POST", `${o.crm}/products`, { name: "Twin", price: 1, image: f }), 201).changes.set.products[0];
  ok(await put({ images: [a, e, f] }));
  ok(await put({ images: [a] }));
  assert.deepEqual([await shown(e), await shown(f), await shown(a)], [404, 200, 200]);
  ok(await o.b.call("PUT", `${o.crm}/products/${twin.id}`, { images: [a] }));
  assert.equal(await shown(f), 404, "the last product that showed it let it go");
  assert.equal(await shown(a), 200, "both still show a");
  // POST products/:id/image keeps the gallery.
  const g = await upload();
  ok(await put({ images: [a, g] }));
  const form = new FormData();
  form.append("file", new Blob([png]), "y.png");
  const set = ok(await o.b.call("POST", `${o.crm}/products/${made.id}/image`, form));
  assert.deepEqual(set.changes.set.products[0].images, [set.image, g]);
  // Limits and checks: 8 at most, each once, each a same-site path, each upload still there.
  const eight = await Promise.all(Array.from({ length: 8 }, () => upload()));
  assert.equal(ok(await put({ images: eight })).changes.set.products[0].images.length, 8);
  assert.equal((await put({ images: [...eight, await upload()] })).status, 400);
  assert.equal((await put({ images: [eight[0], eight[0]] })).status, 400);
  assert.equal((await put({ images: ["https://evil.example/x.jpg"] })).status, 400);
  assert.equal((await put({ images: [""] })).status, 400);
  const foreign = await upload(other);
  assert.deepEqual([(await put({ images: [eight[0], foreign] })).status], [200], "another workspace's path is only a path: not served");
  const gone = `/w/${o.ws.id}/crm/products/images/${crypto.randomUUID()}.png`;
  assert.deepEqual(rules(await put({ images: [eight[0], gone] })), { status: 400, code: "bad_image", hard: undefined, soft: undefined });
  // Deleting the product removes every photo only it showed.
  const h = await upload();
  const lone = ok(await o.b.call("POST", `${o.crm}/products`, { name: "Lone", price: 1, images: [await upload(), h] }), 201).changes.set.products[0];
  ok(await o.b.call("DELETE", `${o.crm}/products/${lone.id}`));
  assert.equal(await shown(h), 404);
  // A product without photos: image "" and images [].
  assert.deepEqual(ok(await put({ images: [] })).changes.set.products[0].images, []);
  assert.equal((await one(o, "products", made.id)).image, "");
});

test("stock: receive, write off, count", async () => {
  const o = await crmOwner();
  const mate = await teammate(o, "agent");
  const a = await product(o, { name: "Roses", cost: 50000 });
  const b = await product(o, { name: "Vase" });
  const [va, vb] = [a.variants[0].id, b.variants[0].id];

  // A team member receives two products at once; a cost given becomes the cost.
  const got = ok(await mate.b.call("POST", `${o.crm}/stock/receive`, { lines: [{ productId: a.id, qty: 10, cost: 55000 }, { variantId: vb, qty: 4 }], note: "Morning delivery" })).changes.set;
  assert.deepEqual(got.products.map((p) => [p.name, p.stock, p.cost]).sort(), [["Roses", 10, 55000], ["Vase", 4, 60000]]);
  assert.deepEqual(got.movements.map((m) => [m.productId, m.type, m.qty, m.by, m.note]).sort(), [[a.id, "receipt", 10, "Sherzod Karimov", "Morning delivery"], [b.id, "receipt", 4, "Sherzod Karimov", "Morning delivery"]].sort());
  assert.equal((await o.b.call("POST", `${o.crm}/stock/receive`, { lines: [] })).status, 400);
  assert.equal((await o.b.call("POST", `${o.crm}/stock/receive`, { lines: [{ productId: a.id, qty: 0 }] })).status, 400);
  assert.equal((await o.b.call("POST", `${o.crm}/stock/receive`, { lines: [{ qty: 1 }] })).status, 400);
  assert.equal((await o.b.call("POST", `${o.crm}/stock/receive`, { lines: [{ productId: crypto.randomUUID(), qty: 1 }] })).body.code, "missing_product");

  // Hold 3 roses for an order, so only 7 are free.
  const c = await customer(o);
  const ord = await order(o, { customerId: c, lines: [{ productId: a.id, qty: 3 }] });
  ok(await step(o, ord.id, "confirmed"));
  assert.deepEqual(await stockOf(o, a.id), [10, 3]);

  // Write off: with a reason, not more than is free.
  assert.equal((await o.b.call("POST", `${o.crm}/stock/write-off`, { productId: a.id, qty: 1 })).status, 400, "a reason is needed");
  const off = ok(await o.b.call("POST", `${o.crm}/stock/write-off`, { productId: a.id, qty: 2, reason: "damaged", note: { en: "Damaged: wilted", ru: "Повреждён: завяли", uz: "Shikastlangan: soʻlgan" } })).changes.set;
  assert.deepEqual([off.products[0].stock, off.products[0].reserved], [8, 3]);
  assert.deepEqual([off.movements[0].type, off.movements[0].qty, off.movements[0].reason, off.movements[0].note.en], ["writeoff", -2, "damaged", "Damaged: wilted"]);
  const short = await o.b.call("POST", `${o.crm}/stock/write-off`, { productId: a.id, qty: 6, reason: "lost" });
  assert.deepEqual(rules(short), { status: 422, code: "rules", hard: [{ code: "write_off_short", variantId: va, productId: a.id, name: "Roses", free: 5, reserved: 3 }], soft: [] });

  // Count: sets the real number and records the difference, never below what orders hold.
  const up = ok(await o.b.call("POST", `${o.crm}/stock/count`, { productId: a.id, counted: 11, note: "Stock count" }));
  assert.deepEqual([up.diff, up.changes.set.products[0].stock, up.changes.set.movements[0].type, up.changes.set.movements[0].qty], [3, 11, "adjust", 3]);
  const down = ok(await o.b.call("POST", `${o.crm}/stock/count`, { variantId: va, counted: 3 }));
  assert.deepEqual([down.diff, down.changes.set.products[0].stock, down.changes.set.movements[0].qty], [-8, 3, -8]);
  assert.deepEqual(rules(await o.b.call("POST", `${o.crm}/stock/count`, { productId: a.id, counted: 3 })).hard, [{ code: "no_difference", variantId: va, productId: a.id, name: "Roses" }]);
  assert.deepEqual(rules(await o.b.call("POST", `${o.crm}/stock/count`, { productId: a.id, counted: 2 })).hard, [{ code: "below_reserved", variantId: va, productId: a.id, name: "Roses", reserved: 3 }]);
  assert.equal((await o.b.call("POST", `${o.crm}/stock/count`, { productId: a.id, counted: -1 })).status, 400);

  // The stock page's list: newest first, and holding goods for an order is not a movement.
  const { movements } = await snap(o, "movements");
  assert.deepEqual(movements.map((m) => [m.type, m.qty]), [["adjust", -8], ["adjust", 3], ["writeoff", -2], ["receipt", 4], ["receipt", 10]]);
  assert.equal((await query("SELECT count(*)::int AS n FROM crm_stock_moves WHERE workspace_id = $1 AND type = 'reserve'", [o.ws.id])).rows[0].n, 1);
  await ledgerHolds(o);

  // The database refuses what the rules would never ask for, and the ledger can't be rewritten.
  const branch = (await query("SELECT id FROM crm_branches WHERE workspace_id = $1", [o.ws.id])).rows[0].id;
  const line = (type, qty) => query("INSERT INTO crm_stock_moves (workspace_id, variant_id, branch_id, type, qty) VALUES ($1, $2, $3, $4, $5)", [o.ws.id, vb, branch, type, qty]);
  await assert.rejects(line("sale", -5), /crm_stock_on_hand/);
  await assert.rejects(line("reserve", 5), /crm_stock_reserved_on_hand/);
  await assert.rejects(line("release", -1), /crm_stock_reserved/);
  await assert.rejects(line("sale", 1), /crm_stock_moves_type/);
  await assert.rejects(line("gift", 1), /crm_stock_moves_type/);
  await assert.rejects(query("UPDATE crm_stock_moves SET qty = qty + 1 WHERE workspace_id = $1", [o.ws.id]), /never changed/);
  await assert.rejects(query("DELETE FROM crm_stock_moves WHERE workspace_id = $1", [o.ws.id]), /never removed/);
  await ledgerHolds(o);
});

test("an order's whole life through the workspace's own steps", async () => {
  const o = await crmOwner();
  // The business renames a step, adds one of its own and asks for things on the way:
  // a recipient before packing, payment before the courier leaves.
  const base0 = (await snap(o, "orderStages")).orderStages;
  const stages = [
    base0[0],
    { id: "confirmed", name: "Accepted", tone: "blue", kind: "reserved" },
    { id: "packing", name: base0[2].name, tone: "blue", kind: "reserved", needs: { fields: ["recipient"] } },
    { id: "florist", name: "At the florist", tone: "amber", kind: "reserved" },
    { id: "delivering", name: base0[3].name, tone: "blue", kind: "reserved", needs: { paid: true } },
    base0[4],
    base0[5],
  ];
  await settings(o, { orderStages: stages, fields: { order: [{ id: "recipient", name: "Recipient", type: "text", card: true }] } });
  const roses = await product(o, { name: "Roses", price: 100000, opening: 5 });
  const card = await product(o, { name: "Card", price: 5000, opening: 50 });
  const vr = roses.variants[0].id;

  // A new customer comes with the order. It lands in the first open step and holds nothing.
  const made = await order(o, { customer: { name: "Nilufar", phone: "90 123 45 67" }, lines: [{ productId: roses.id, qty: 2 }, { productId: card.id, qty: 1 }], delivery: { type: "courier", address: "Chilonzor 9" }, payment: "click", source: "telegram", note: "Call first" });
  const ord = made.changes.set.orders[0];
  assert.deepEqual(made.changes.set.customers.map((c) => [c.name, c.phone, c.source]), [["Nilufar", "+998901234567", "telegram"]]);
  assert.deepEqual([ord.number, ord.status, ord.customerId, ord.payment, ord.source, ord.note, ord.paid, ord.discount], [1001, "new", made.changes.set.customers[0].id, "click", "telegram", "Call first", false, 0]);
  assert.deepEqual(ord.lines.map((l) => [l.productId, l.variantId === vr, l.qty, l.price, l.discount]), [[roses.id, true, 2, 100000, 0], [card.id, false, 1, 5000, 0]]);
  assert.deepEqual(ord.delivery, { type: "courier", address: "Chilonzor 9", date: "", slot: "", time: "", fee: 30000 });
  assert.deepEqual(ord.totals, { lines: 205000, lineDiscounts: 0, subtotal: 205000, discount: 0, fee: 30000, total: 235000, paid: 0, refunded: 0, balance: 235000 });
  assert.deepEqual(ord.history.map((h) => [h.text, h.by]), [["created", "Kamola Yusupova"]]);
  assert.deepEqual(await stockOf(o, roses.id), [5, 0]);
  assert.equal((await order(o, { customerId: ord.customerId, lines: [{ productId: card.id, qty: 1 }] })).changes.set.orders[0].number, 1002);

  // Accepted: the goods are held. The answer carries the order and both products, no movements.
  const held = ok(await step(o, ord.id, "confirmed"));
  assert.equal(held.change, "reserved");
  assert.deepEqual(held.changes.set.orders[0].status, "confirmed");
  assert.deepEqual(held.changes.set.products.map((p) => [p.name, p.stock, p.reserved]).sort(), [["Card", 50, 1], ["Roses", 5, 2]]);
  assert.equal(held.changes.set.movements, undefined);
  assert.deepEqual(held.changes.set.orders[0].history.at(-1), { text: "moved", to: "confirmed", toName: "Accepted", at: held.changes.set.orders[0].history.at(-1).at, by: "Kamola Yusupova" });

  // Packing asks for the recipient; every later step does too.
  assert.deepEqual(rules(await step(o, ord.id, "packing")), { status: 422, code: "rules", hard: [{ code: "needs_field", field: "recipient" }], soft: [] });
  assert.deepEqual(rules(await step(o, ord.id, "delivering")).hard, [{ code: "needs_paid" }, { code: "needs_field", field: "recipient" }]);
  assert.deepEqual(rules(await step(o, ord.id, "delivered")).hard, [{ code: "needs_paid" }, { code: "needs_field", field: "recipient" }]);
  ok(await o.b.call("PUT", `${o.crm}/orders/${ord.id}`, { fields: { recipient: "Madina opa" } }));
  // Between reserved steps nothing moves: the same 2 stay held.
  for (const to of ["packing", "florist", "packing", "florist"]) {
    const r = ok(await step(o, ord.id, to));
    assert.deepEqual([r.change, r.changes.set.products, r.changes.set.orders[0].status], [null, undefined, to]);
  }
  assert.deepEqual(await stockOf(o, roses.id), [5, 2]);

  // The courier leaves only with a paid order: part payment is not enough, the rest is.
  assert.deepEqual(rules(await step(o, ord.id, "delivering")).hard, [{ code: "needs_paid" }]);
  const part = ok(await o.b.call("POST", `${o.crm}/orders/${ord.id}/pay`, { amount: 100000, method: "cash" })).changes.set.orders[0];
  assert.deepEqual([part.paid, part.totals.paid, part.totals.balance, part.history.at(-1).text, part.history.at(-1).amount], [false, 100000, 135000, "part_paid", 100000]);
  assert.deepEqual(rules(await step(o, ord.id, "delivering")).hard, [{ code: "needs_paid" }]);
  const over = await o.b.call("POST", `${o.crm}/orders/${ord.id}/pay`, { amount: 135001 });
  assert.deepEqual([over.status, over.body.code, over.body.balance], [409, "over_balance", 135000]);
  const full = ok(await o.b.call("POST", `${o.crm}/orders/${ord.id}/pay`, {})).changes.set.orders[0];
  assert.deepEqual([full.paid, full.totals.balance, full.history.at(-1).text], [true, 0, "paid"]);
  assert.deepEqual(full.payments.map((p) => [p.amount, p.method, p.by]), [[100000, "cash", "Kamola Yusupova"], [135000, "click", "Kamola Yusupova"]]);
  assert.equal((await o.b.call("POST", `${o.crm}/orders/${ord.id}/pay`, {})).body.code, "already_paid");
  assert.equal((await o.b.call("POST", `${o.crm}/orders/${ord.id}/pay`, { amount: 1, method: "shells" })).status, 409);
  ok(await step(o, ord.id, "delivering"));

  // The board changes under the order: a step is renamed, the business's own step is removed
  // with the order's old neighbours moved out of it. The order and its stock stay as they are.
  const second = (await order(o, { customerId: ord.customerId, lines: [{ productId: roses.id, qty: 1 }], fields: { recipient: "Zarina" } })).changes.set.orders[0];
  ok(await step(o, second.id, "florist"));
  const without = stages.filter((s) => s.id !== "florist").map((s) => (s.id === "delivering" ? { ...s, name: "With the courier" } : s));
  const stuck = await o.b.call("PUT", `${o.crm}/settings`, { orderStages: without });
  assert.deepEqual([stuck.status, stuck.body.code, stuck.body.id, stuck.body.count], [409, "stage_needs_move", "florist", 1]);
  const wrong = await o.b.call("PUT", `${o.crm}/settings`, { orderStages: without, moves: { orderStages: [{ from: "florist", to: "new" }] } });
  assert.deepEqual([wrong.status, wrong.body.code], [400, "bad_move"]);
  const moved = await settings(o, { orderStages: without, moves: { orderStages: [{ from: "florist", to: "packing" }] } });
  assert.deepEqual(moved.changes.set.orders.map((x) => [x.id, x.status]), [[second.id, "packing"]]);
  assert.deepEqual(await stockOf(o, roses.id), [5, 3]);
  const changed = await o.b.call("PUT", `${o.crm}/settings`, { orderStages: without.map((s) => (s.id === "packing" ? { ...s, kind: "open" } : s)) });
  assert.deepEqual([changed.status, changed.body.code], [409, "stage_in_use"]);
  await ledgerHolds(o);

  // Handed over: the goods leave stock, one sale per product, written by who did it.
  const done = ok(await step(o, ord.id, "delivered", { note: "Left with the neighbour" }));
  assert.equal(done.change, "sold");
  assert.deepEqual(done.changes.set.products.map((p) => [p.name, p.stock, p.reserved]).sort(), [["Card", 49, 0], ["Roses", 3, 1]]);
  assert.deepEqual(done.changes.set.movements.map((m) => [m.type, m.qty, m.orderId, m.by]).sort(), [["sale", -1, ord.id, "Kamola Yusupova"], ["sale", -2, ord.id, "Kamola Yusupova"]]);
  assert.deepEqual([done.changes.set.orders[0].history.at(-1).toName, done.changes.set.orders[0].history.at(-1).note], [stages[5].name, "Left with the neighbour"]);
  assert.equal(done.changes.set.orders[0].payments.length, 2, "it was paid already: handing over adds no payment");

  // A finished order is closed, except for a return.
  for (const to of ["new", "confirmed", "delivering"]) assert.deepEqual(rules(await step(o, ord.id, to)).hard, [{ code: "done_closed" }]);
  assert.equal((await o.b.call("PUT", `${o.crm}/orders/${ord.id}`, { lines: [{ productId: card.id, qty: 1 }] })).body.hard[0].code, "lines_locked");
  assert.equal(rules(await step(o, ord.id, "nowhere")).hard[0].code, "missing_stage");
  const same = ok(await step(o, ord.id, "delivered"));
  assert.equal(same.changes.set.orders[0].history.length, done.changes.set.orders[0].history.length, "moving to the step it is in changes nothing");
  const back = ok(await step(o, ord.id, "cancelled", { note: "Wrong bouquet" }));
  assert.equal(back.change, "returned");
  assert.deepEqual([back.changes.set.orders[0].status, back.changes.set.orders[0].returned, back.changes.set.orders[0].history.at(-1).text], ["cancelled", true, "returned"]);
  assert.deepEqual(back.changes.set.movements.map((m) => [m.type, m.qty, m.note]).sort(), [["return", 1, "Wrong bouquet"], ["return", 2, "Wrong bouquet"]]);
  assert.deepEqual(await stockOf(o, roses.id), [5, 1]);
  for (const to of ["new", "confirmed", "delivered"]) assert.deepEqual(rules(await step(o, ord.id, to)).hard, [{ code: "returned_closed" }]);

  // Straight from open to done: sold from the shelf, and handing over settles the bill.
  const quick = (await order(o, { customerId: ord.customerId, lines: [{ productId: card.id, qty: 2 }], payment: "cash", fields: { recipient: "R" } })).changes.set.orders[0];
  assert.deepEqual(rules(await step(o, quick.id, "delivered")).hard, [{ code: "needs_paid" }]); // "delivering" asks for it, and it comes before
  await settings(o, { orderStages: without.map(({ needs, ...s }) => s) });
  const sold = ok(await step(o, quick.id, "delivered")).changes.set;
  assert.deepEqual([sold.orders[0].paid, sold.orders[0].payments.map((p) => [p.amount, p.method])], [true, [[10000, "cash"]]]);
  assert.deepEqual(sold.products.map((p) => [p.stock, p.reserved]), [[48, 0]]);

  // Cancelling an accepted order lets its goods go; reopening a cancelled one holds nothing.
  const off = ok(await o.b.call("POST", `${o.crm}/orders/${second.id}/cancel`, { note: "Changed their mind" }));
  assert.deepEqual([(await o.b.call("POST", `${o.crm}/orders/${second.id}/pay`, {})).status, (await o.b.call("POST", `${o.crm}/orders/${second.id}/pay`, {})).body.code], [409, "order_cancelled"]);
  assert.deepEqual([off.change, off.changes.set.orders[0].status, off.changes.set.orders[0].history.at(-1).note, off.changes.set.products[0].reserved], ["released", "cancelled", "Changed their mind", 0]);
  ok(await step(o, second.id, "new"));
  assert.deepEqual(await stockOf(o, roses.id), [5, 0]);
  await ledgerHolds(o);

  // The customer's panel and the customer's delete both know about the orders.
  const hist = ok(await o.b.call("GET", `${o.crm}/customers/${ord.customerId}/history`));
  assert.deepEqual(hist.orders.map((x) => x.number), [1004, 1003, 1002, 1001]);
  const del = await o.b.call("DELETE", `${o.crm}/customers/${ord.customerId}`);
  assert.deepEqual([del.status, del.body.code, del.body.uses.orders], [409, "customer_in_use", 4]);
  // Lists the orders use can't lose those items.
  for (const [key, list, id] of [["paymentMethods", [{ id: "cash", name: "Cash" }], "click"], ["deliveryMethods", [{ id: "pickup", name: "Pickup", icon: "bag", address: false, fee: 0 }], "courier"], ["sources", [{ id: "phone", name: "Phone", icon: "phone" }], "telegram"]]) {
    const r = await o.b.call("PUT", `${o.crm}/settings`, { [key]: list });
    assert.deepEqual([r.status, r.body.code, r.body.id], [409, "in_use", id], key);
  }
});

test("editing an order: what is held follows its items", async () => {
  const o = await crmOwner();
  const a = await product(o, { name: "Roses", price: 100000, opening: 5 });
  const b = await product(o, { name: "Vase", price: 40000, opening: 1 });
  const gone = await product(o, { name: "Old", price: 1000, opening: 9, onSale: false });
  const c = await customer(o);
  const c2 = await customer(o, "Zarina");
  const put = (id, body) => o.b.call("PUT", `${o.crm}/orders/${id}`, body);

  // A product that is off sale can't be added to an order; none of the lines may be empty-handed.
  assert.deepEqual(rules(await o.b.call("POST", `${o.crm}/orders`, { customerId: c, lines: [{ productId: gone.id, qty: 1 }], delivery: { type: "pickup" } })).hard, [{ code: "off_sale", variantId: gone.variants[0].id, productId: gone.id, name: "Old" }]);
  assert.deepEqual(rules(await o.b.call("POST", `${o.crm}/orders`, { customerId: c, lines: [{ productId: a.id, qty: 0 }], delivery: { type: "pickup" } })).hard, [{ code: "no_lines" }]);
  for (const body of [{ lines: [{ productId: a.id, qty: 1 }] }, { customerId: c, customer: { name: "X" }, lines: [{ productId: a.id, qty: 1 }] }, { customerId: c, lines: [] }]) assert.equal((await o.b.call("POST", `${o.crm}/orders`, body)).status, 400);
  assert.equal((await o.b.call("POST", `${o.crm}/orders`, { customerId: crypto.randomUUID(), lines: [{ productId: a.id, qty: 1 }] })).body.code, "bad_customer");
  assert.equal((await o.b.call("POST", `${o.crm}/orders`, { customerId: c, lines: [{ productId: a.id, qty: 1 }], payment: "shells" })).body.code, "bad_payment");
  assert.equal((await o.b.call("POST", `${o.crm}/orders`, { customerId: c, lines: [{ productId: a.id, qty: 1 }], source: "smoke" })).body.code, "bad_source");
  assert.equal((await o.b.call("POST", `${o.crm}/orders`, { customerId: c, lines: [{ productId: a.id, qty: 1 }], delivery: { type: "drone" } })).body.code, "bad_delivery");
  assert.deepEqual(rules(await o.b.call("POST", `${o.crm}/orders`, { customerId: c, lines: [{ productId: a.id, qty: 1 }], delivery: { type: "courier" } })).hard, [{ code: "address_required" }]);
  assert.equal((await o.b.call("POST", `${o.crm}/orders`, { customer: { name: "X", phone: "123" }, lines: [{ productId: a.id, qty: 1 }] })).body.code, "bad_phone");

  // Not accepted yet: any quantity can be written down, nothing is held.
  const ord = (await order(o, { customerId: c, lines: [{ productId: a.id, qty: 9 }] })).changes.set.orders[0];
  assert.deepEqual(rules(await step(o, ord.id, "confirmed")).hard, [{ code: "short", variantId: a.variants[0].id, productId: a.id, name: "Roses", need: 9, free: 5, missing: 4 }]);
  const cut = ok(await put(ord.id, { lines: [{ productId: a.id, qty: 2 }] }));
  assert.deepEqual([cut.changes.set.products, cut.changes.set.orders[0].history.at(-1).text], [undefined, "edited"]);
  ok(await step(o, ord.id, "confirmed"));
  assert.deepEqual(await stockOf(o, a.id), [5, 2]);

  // Accepted: more of one, a new product, and the answer has every product whose stock moved.
  const more = ok(await put(ord.id, { lines: [{ ...cut.changes.set.orders[0].lines[0], qty: 4 }, { productId: b.id, qty: 1, discount: 5000 }] })).changes.set;
  assert.deepEqual(more.products.map((p) => [p.name, p.stock, p.reserved]).sort(), [["Roses", 5, 4], ["Vase", 1, 1]]);
  assert.deepEqual(more.orders[0].lines.map((l) => [l.qty, l.price, l.discount]), [[4, 100000, 0], [1, 40000, 5000]]);
  assert.equal(more.orders[0].totals.total, 435000);
  // Only the extra is checked against what is free: 4 held + 1 free, 6 wanted.
  assert.deepEqual(rules(await put(ord.id, { lines: [{ productId: a.id, qty: 6 }] })).hard, [{ code: "short", variantId: a.variants[0].id, productId: a.id, name: "Roses", need: 2, free: 1, missing: 1 }]);
  assert.deepEqual(await stockOf(o, a.id), [5, 4], "a refused edit changes nothing");
  // Fewer, and one product dropped: the rest is let go.
  const less = ok(await put(ord.id, { lines: [{ productId: a.id, qty: 1 }, { productId: b.id, qty: 0 }] })).changes.set;
  assert.deepEqual(less.products.map((p) => [p.name, p.stock, p.reserved]).sort(), [["Roses", 5, 1], ["Vase", 1, 0]]);
  // A price kept from before, a price set by hand, and a product taken off sale meanwhile can stay but not come in.
  ok(await o.b.call("PUT", `${o.crm}/products/${a.id}`, { price: 150000, onSale: false }));
  const priced = ok(await put(ord.id, { lines: [{ productId: a.id, qty: 2 }, { productId: b.id, qty: 1, price: 35000 }] })).changes.set.orders[0];
  assert.deepEqual(priced.lines.map((l) => [l.qty, l.price]), [[2, 100000], [1, 35000]]);
  assert.equal(rules(await put(ord.id, { lines: [{ productId: a.id, qty: 2 }, { productId: gone.id, qty: 1 }] })).hard[0].code, "off_sale");
  assert.equal((await put(ord.id, { lines: [{ productId: a.id, qty: 1, discount: 100001 }] })).body.code, "bad_discount");

  // Everything else: only what is sent changes, each change leaves a line in the history.
  const rest = ok(await put(ord.id, { note: "Ring twice", payment: "payme", customerId: c2, source: "phone", delivery: { type: "courier", address: "Sergeli 7" }, discount: 15000 })).changes.set.orders[0];
  assert.deepEqual([rest.note, rest.payment, rest.customerId, rest.source, rest.discount], ["Ring twice", "payme", c2, "phone", 15000]);
  assert.deepEqual(rest.delivery, { type: "courier", address: "Sergeli 7", date: "", slot: "", time: "", fee: 30000 });
  assert.deepEqual(rest.totals, { lines: 235000, lineDiscounts: 0, subtotal: 235000, discount: 15000, fee: 30000, total: 250000, paid: 0, refunded: 0, balance: 250000 });
  assert.deepEqual(rest.history.slice(-5).map((h) => h.text), ["customer", "payment", "note", "delivery", "discount"]);
  const lines = async () => (await query("SELECT count(*)::int AS n FROM crm_stock_moves WHERE order_id = $1", [ord.id])).rows[0].n;
  const before = await lines();
  const quiet = ok(await put(ord.id, { note: "Ring twice", payment: "payme", delivery: { address: "Sergeli 7" }, lines: rest.lines, fields: {} })).changes.set.orders[0];
  assert.equal(quiet.history.length, rest.history.length, "sending what is already there writes no history");
  assert.equal(await lines(), before, "nor any ledger line");
  assert.equal((await put(ord.id, { discount: 235001 })).body.code, "bad_discount");
  assert.equal((await put(ord.id, { delivery: { address: "" } })).body.hard[0].code, "address_required");
  assert.equal((await put(ord.id, { delivery: { slot: "12:00–15:00", time: "14:20" } })).body.code, "bad_delivery_time");
  assert.deepEqual([ok(await put(ord.id, { delivery: { time: "14:20" } })).changes.set.orders[0].delivery.time, ok(await put(ord.id, { delivery: { slot: "12:00–15:00" } })).changes.set.orders[0].delivery.time], ["14:20", ""]);
  assert.equal((await put(ord.id, {})).status, 400);
  assert.equal((await put(ord.id, { status: "delivered" })).status, 400, "the step changes only through /step");
  assert.equal((await put(crypto.randomUUID(), { note: "x" })).status, 404);

  // Finished: items and the discount are locked, the rest can still be corrected.
  ok(await step(o, ord.id, "delivered"));
  assert.deepEqual(rules(await put(ord.id, { lines: [{ productId: a.id, qty: 1 }] })).hard, [{ code: "lines_locked" }]);
  assert.deepEqual(rules(await put(ord.id, { discount: 0 })).hard, [{ code: "lines_locked" }]);
  ok(await put(ord.id, { note: "Delivered to the door" }));
  await ledgerHolds(o);
});

test("delivery rules through the API", async () => {
  const o = await crmOwner();
  const mate = await teammate(o, "agent");
  const p = await product(o, { opening: 100 });
  const c = await customer(o);
  const now = nowIn("Asia/Tashkent", new Date());
  const today = now.slice(0, 10);
  const day = (n) => addDays(today, n);
  const delivery = { time: "both", windows: [{ from: "09:00", to: "12:00" }, { from: "12:00", to: "15:00" }], daysOff: [weekday(day(3))], closed: [{ date: day(2), note: "Stock count" }], sameDayUntil: "", prepMinutes: 0, maxDays: 5, override: true };
  await settings(o, { settings: { delivery } });
  const post = (d, extra, who = mate) => who.b.call("POST", `${o.crm}/orders`, { customerId: c, lines: [{ productId: p.id, qty: 1 }], delivery: { type: "pickup", ...d }, ...extra });

  // Inside the rules: saved as it is, by a team member, with nothing to force.
  const fine = ok(await post({ date: day(1), slot: "12:00–15:00" }), 201).changes.set.orders[0];
  assert.deepEqual(fine.delivery, { type: "pickup", address: "", date: day(1), slot: "12:00–15:00", time: "", fee: 0 });
  ok(await post({ date: day(1), time: "14:20" }), 201);

  // Each rule: refused with its reason, saved with `force`.
  const cases = [
    [{ date: day(2), slot: "09:00–12:00" }, { code: "closed_day", date: day(2), note: "Stock count" }],
    [{ date: day(3), time: "10:00" }, { code: "day_off", weekday: weekday(day(3)) }],
    [{ date: day(6), time: "10:00" }, { code: "too_far", maxDays: 5 }],
    [{ date: today, time: "00:00" }, { code: "time_passed" }],
  ];
  for (const [d, reason] of cases) {
    assert.deepEqual(rules(await post(d)), { status: 422, code: "rules", hard: [], soft: [reason] }, reason.code);
    assert.deepEqual(rules(await post(d, { force: false })).soft, [reason]);
    ok(await post(d, { force: true }), 201);
  }
  // A window that is over, and a time too soon to prepare (when the clock leaves room to try).
  await settings(o, { settings: { delivery: { ...delivery, windows: [{ from: "00:00", to: "00:01" }], prepMinutes: 43200 } } });
  if (now.slice(11) >= "00:01") assert.deepEqual(rules(await post({ date: today, slot: "00:00–00:01" })).soft, [{ code: "window_ended" }]);
  if (now.slice(11) < "23:50") {
    const soon = rules(await post({ date: today, time: "23:59" }));
    assert.deepEqual([soon.status, soon.soft.length, soon.soft[0].code, soon.soft[0].prepMinutes], [422, 1, "too_soon", 43200]);
    assert.match(soon.soft[0].earliest, /^\d\d:\d\d$/);
  }
  // After the same-day cutoff, today is closed for new orders.
  await settings(o, { settings: { delivery: { ...delivery, sameDayUntil: "00:00" } } });
  if (now.slice(11) > "00:01") assert.deepEqual(rules(await post({ date: today, time: "23:59" })).soft, [{ code: "after_cutoff", time: "00:00" }]);

  // A day that has passed can't be planned by anyone, force or not.
  assert.deepEqual(rules(await post({ date: day(-1), time: "10:00" }, { force: true }, o)), { status: 422, code: "rules", hard: [{ code: "past_day" }], soft: [] });
  // Malformed days and times never reach the rules.
  for (const d of [{ date: "2026-02-30" }, { date: "tomorrow" }, { time: "25:00" }, { slot: "12-15" }, { nonsense: 1 }]) assert.equal((await post(d)).status, 400, JSON.stringify(d));

  // The same on an edit, and only when the day or time is new.
  await settings(o, { settings: { delivery } });
  const put = (body) => mate.b.call("PUT", `${o.crm}/orders/${fine.id}`, body);
  assert.deepEqual(rules(await put({ delivery: { date: day(2) } })).soft, [{ code: "closed_day", date: day(2), note: "Stock count" }]);
  const forced = ok(await put({ delivery: { date: day(2) }, force: true })).changes.set.orders[0];
  assert.equal(forced.delivery.date, day(2));
  ok(await put({ delivery: { type: "courier", address: "Chilonzor 9" } })); // still the closed day, but the day is not what changed
  assert.equal(ok(await put({ note: "x" })).changes.set.orders[0].delivery.fee, 30000);
  assert.equal(ok(await put({ delivery: { type: "pickup" } })).changes.set.orders[0].delivery.fee, 0, "the fee follows the method");

  // With override off, the team is held to the rules too.
  await settings(o, { settings: { delivery: { ...delivery, override: false } } });
  assert.deepEqual(rules(await post({ date: day(2), time: "10:00" }, { force: true }, o)), { status: 422, code: "rules", hard: [], soft: [{ code: "closed_day", date: day(2), note: "Stock count" }] });
  ok(await post({ date: day(1), time: "10:00" }), 201);
});

test("money: discounts, part payments and refunds add up; the receipt", async () => {
  const o = await crmOwner("Kamola Yusupova", "Guldasta");
  const admin = await teammate(o, "admin", "Aziza Admin");
  const mate = await teammate(o, "agent");
  const tee = ok(await o.b.call("POST", `${o.crm}/products`, { name: "T-shirt", unit: "pcs", options: [{ id: "size", name: "Size", values: ["M", "L"] }], variants: [{ values: { size: "M" }, sku: "TS-M", price: 90000, opening: 10 }, { values: { size: "L" }, sku: "TS-L", price: 95000, opening: 10 }] }), 201).changes.set.products[0];
  const card = await product(o, { name: "Card", sku: "CARD", price: 5000, opening: 10 });
  const c = ok(await o.b.call("POST", `${o.crm}/customers`, { name: "Madina", phone: "+998901112233" }), 201).id;
  const L = tee.variants[1].id;

  // Paid in full on the spot: one payment for the whole sum, by the order's method.
  const made = (await order(o, { customerId: c, lines: [{ variantId: L, qty: 2, discount: 10000 }, { productId: card.id, qty: 3 }], discount: 5000, delivery: { type: "courier", address: "Navoiy 21" }, payment: "payme", paid: true })).changes.set.orders[0];
  const sums = { lines: 205000, lineDiscounts: 10000, subtotal: 195000, discount: 5000, fee: 30000, total: 220000 };
  assert.deepEqual(made.totals, { ...sums, paid: 220000, refunded: 0, balance: 0 });
  assert.deepEqual([made.paid, made.payments.map((p) => [p.amount, p.method])], [true, [[220000, "payme"]]]);
  const id = made.id;
  const refund = (body, who = o) => who.b.call("POST", `${o.crm}/orders/${id}/refund`, body);

  // Refunds are for admins and the owner; never more than was paid.
  assert.equal((await refund({ amount: 1000 }, mate)).status, 403);
  const tooMuch = await refund({ amount: 220001 });
  assert.deepEqual([tooMuch.status, tooMuch.body.code, tooMuch.body.paid], [409, "over_paid", 220000]);
  const r1 = ok(await refund({ amount: 20000, method: "cash", note: "A card was missing" }, admin)).changes.set.orders[0];
  assert.deepEqual([r1.paid, r1.totals.paid, r1.totals.balance], [false, 200000, 20000]);
  assert.deepEqual(r1.payments.at(-1), { id: r1.payments.at(-1).id, amount: -20000, method: "cash", at: r1.payments.at(-1).at, by: "Aziza Admin", note: "A card was missing" });
  assert.deepEqual([r1.history.at(-1).text, r1.history.at(-1).amount, r1.history.at(-1).by], ["refunded", 20000, "Aziza Admin"]);
  // The order gets cheaper by the same sum: paid in full again. Then dearer: a balance to pay.
  const cheaper = ok(await o.b.call("PUT", `${o.crm}/orders/${id}`, { discount: 25000 })).changes.set.orders[0];
  assert.deepEqual([cheaper.paid, cheaper.totals.total, cheaper.totals.balance], [true, 200000, 0]);
  const dearer = ok(await o.b.call("PUT", `${o.crm}/orders/${id}`, { lines: [{ variantId: L, qty: 2, discount: 10000 }, { productId: card.id, qty: 5 }], discount: 0 })).changes.set.orders[0];
  assert.deepEqual([dearer.paid, dearer.totals.total, dearer.totals.paid, dearer.totals.balance], [false, 235000, 200000, 35000]);
  const p2 = ok(await mate.b.call("POST", `${o.crm}/orders/${id}/pay`, { amount: 5000, note: "Tip jar" })).changes.set.orders[0];
  assert.deepEqual([p2.totals.paid, p2.totals.balance, p2.payments.at(-1).method, p2.payments.at(-1).note], [205000, 30000, "payme", "Tip jar"]);
  // Every sum is the payments added up.
  assert.equal(p2.payments.reduce((s, p) => s + p.amount, 0), p2.totals.paid);
  assert.equal(Number((await query("SELECT sum(amount) AS s FROM crm_payments WHERE order_id = $1", [id])).rows[0].s), 205000);

  // Handing over settles the last 30 000 by the order's method.
  ok(await step(o, id, "confirmed"));
  const done = ok(await step(o, id, "delivered")).changes.set.orders[0];
  assert.deepEqual([done.paid, done.totals.balance, done.payments.at(-1).amount, done.payments.at(-1).method], [true, 0, 30000, "payme"]);

  // The receipt: everything a printed slip needs, with the names as the workspace wrote them.
  const slip = ok(await mate.b.call("GET", `${o.crm}/orders/${id}/receipt`));
  assert.deepEqual(slip.business, { name: "Guldasta", branch: "", address: "" });
  assert.deepEqual([slip.number, slip.date, slip.status, slip.statusName.en, slip.paid, slip.note], [1001, made.createdAt, "delivered", "Delivered", true, ""]);
  assert.match(slip.printedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d$/);
  assert.deepEqual(slip.customer, { name: "Madina", phone: "+998901112233" });
  assert.deepEqual(slip.lines.map(({ productId, variantId, unitName, ...l }) => [l, unitName.en]), [
    [{ name: "T-shirt", variant: "L", sku: "TS-L", unit: "pcs", qty: 2, price: 95000, discount: 10000, total: 180000 }, "pcs"],
    [{ name: "Card", variant: "", sku: "CARD", unit: "pcs", qty: 5, price: 5000, discount: 0, total: 25000 }, "pcs"],
  ]);
  assert.deepEqual(slip.totals, { lines: 215000, lineDiscounts: 10000, subtotal: 205000, discount: 0, fee: 30000, total: 235000, paid: 235000, refunded: 20000, balance: 0 });
  assert.deepEqual([slip.delivery.name.en, slip.delivery.address, slip.delivery.fee, slip.payment, slip.paymentName], ["Courier", "Navoiy 21", 30000, "payme", "Payme"]);
  assert.deepEqual(slip.payments.map((p) => [p.amount, p.method, p.methodName.en || p.methodName]), [[220000, "payme", "Payme"], [-20000, "cash", "Cash"], [5000, "payme", "Payme"], [30000, "payme", "Payme"]]);
  assert.equal((await o.b.call("GET", `${o.crm}/orders/${crypto.randomUUID()}/receipt`)).status, 404);

  // A refund with the goods coming back: money out, stock in, the order closed as returned.
  assert.equal((await refund({ returnGoods: true, amount: 1 }, mate)).status, 403);
  const back = ok(await refund({ returnGoods: true, note: "Wrong size" })).changes.set;
  assert.deepEqual([back.orders[0].status, back.orders[0].returned, back.orders[0].totals.paid, back.orders[0].payments.at(-1).amount], ["cancelled", true, 0, -235000]);
  assert.deepEqual(back.orders[0].history.slice(-2).map((h) => h.text), ["returned", "refunded"]);
  assert.deepEqual(back.movements.map((m) => [m.type, m.qty]).sort(), [["return", 2], ["return", 5]]);
  assert.deepEqual(back.products.map((p) => [p.name, p.stock, p.reserved]).sort(), [["Card", 10, 0], ["T-shirt", 20, 0]]);
  assert.equal((await refund({})).body.code, "nothing_paid");

  // Goods come back only from a finished order.
  const open = (await order(o, { customerId: c, lines: [{ productId: card.id, qty: 1 }], paid: true })).changes.set.orders[0];
  assert.equal((await o.b.call("POST", `${o.crm}/orders/${open.id}/refund`, { returnGoods: true })).body.code, "not_done");
  assert.equal(ok(await o.b.call("POST", `${o.crm}/orders/${open.id}/refund`, {})).changes.set.orders[0].totals.paid, 0);
  await ledgerHolds(o);
});

test("a refund on a finished order without the goods is a reduction: the order stays paid, every sum agrees", async () => {
  const o = await crmOwner();
  const roses = await product(o, { name: "Roses", price: 100000, opening: 5 });
  const c = await customer(o);
  // Paid on the spot: the history says so, as it does for a payment taken by hand.
  const spot = (await order(o, { customerId: c, lines: [{ productId: roses.id, qty: 1 }], payment: "cash", paid: true })).changes.set.orders[0];
  assert.deepEqual(spot.history.map((h) => [h.text, h.amount, h.method]), [["created", undefined, undefined], ["paid", 100000, "cash"]]);

  // Handing over takes the rest by the order's method, and the history has a "paid" line for it.
  const made = (await order(o, { customerId: c, lines: [{ productId: roses.id, qty: 2 }], payment: "click" })).changes.set.orders[0];
  ok(await o.b.call("POST", `${o.crm}/orders/${made.id}/pay`, { amount: 50000, method: "cash" }));
  const done = ok(await step(o, made.id, "delivered")).changes.set.orders[0];
  assert.deepEqual(done.history.slice(-2).map(({ at, ...h }) => h), [
    { text: "moved", to: "delivered", toName: done.history.at(-2).toName, by: "Kamola Yusupova" },
    { text: "paid", amount: 150000, method: "click", by: "Kamola Yusupova" },
  ]);
  assert.deepEqual(done.payments.map((p) => [p.amount, p.method]), [[50000, "cash"], [150000, "click"]]);

  // 30 000 back, the goods stay with the customer: still paid in full, the refund its own number.
  const r = ok(await o.b.call("POST", `${o.crm}/orders/${made.id}/refund`, { amount: 30000, method: "cash" })).changes.set.orders[0];
  assert.deepEqual([r.paid, r.totals.total, r.totals.paid, r.totals.refunded, r.totals.balance], [true, 200000, 170000, 30000, 0]);
  assert.equal((await o.b.call("POST", `${o.crm}/orders/${made.id}/pay`, {})).body.code, "already_paid");
  // The board, the receipt and the panel say the same.
  assert.deepEqual(await one(o, "orders", made.id).then((x) => [x.paid, x.totals]), [true, r.totals]);
  const slip = ok(await o.b.call("GET", `${o.crm}/orders/${made.id}/receipt`));
  assert.deepEqual([slip.paid, slip.totals], [true, r.totals]);
  // The reports count the order and the refund apart; orders less refunds is what the order kept
  // (the order paid on the spot was never handed over, so it is not income yet).
  const today = nowIn("Asia/Tashkent", new Date()).slice(0, 10);
  const income = ok(await o.b.call("GET", `${o.crm}/reports/income?from=${today}&to=${today}`)).total;
  assert.deepEqual([income.orders, income.refunds, income.net], [200000, 30000, r.totals.paid]);

  // The rest given back with the goods: the order is closed as returned, nothing kept.
  const back = ok(await o.b.call("POST", `${o.crm}/orders/${made.id}/refund`, { returnGoods: true })).changes.set.orders[0];
  assert.deepEqual([back.returned, back.totals.paid, back.totals.refunded], [true, 0, 200000]);
});

test("cancel and delete", async () => {
  const o = await crmOwner();
  const mate = await teammate(o, "agent");
  const p = await product(o, { opening: 5 });
  const c = await customer(o);
  const make = async (extra) => (await order(o, { customerId: c, lines: [{ productId: p.id, qty: 1 }], ...extra })).changes.set.orders[0];

  // An order that left no trace can go: admins only.
  const fresh = await make();
  assert.equal((await mate.b.call("DELETE", `${o.crm}/orders/${fresh.id}`)).status, 403);
  assert.deepEqual(ok(await o.b.call("DELETE", `${o.crm}/orders/${fresh.id}`)).changes, { del: { orders: [fresh.id] } });
  assert.equal((await o.b.call("DELETE", `${o.crm}/orders/${fresh.id}`)).status, 404);
  assert.equal((await query("SELECT count(*)::int AS n FROM crm_order_lines WHERE order_id = $1", [fresh.id])).rows[0].n, 0);
  // Cancelled before it was accepted: still no trace.
  const early = await make();
  assert.equal(ok(await mate.b.call("POST", `${o.crm}/orders/${early.id}/cancel`, {})).change, null);
  ok(await o.b.call("DELETE", `${o.crm}/orders/${early.id}`));

  // One that ever held stock stays, even after it was cancelled and the stock let go.
  const held = await make();
  ok(await step(o, held.id, "confirmed"));
  ok(await o.b.call("POST", `${o.crm}/orders/${held.id}/cancel`, {}));
  assert.deepEqual(await stockOf(o, p.id), [5, 0]);
  const no = await o.b.call("DELETE", `${o.crm}/orders/${held.id}`);
  assert.deepEqual([no.status, no.body.code], [409, "held_stock"]);
  // One with money recorded stays too, even when it was all refunded.
  const paid = await make({ paid: true });
  ok(await o.b.call("POST", `${o.crm}/orders/${paid.id}/refund`, {}));
  assert.equal((await o.b.call("DELETE", `${o.crm}/orders/${paid.id}`)).body.code, "has_payments");
  assert.deepEqual((await snap(o, "orders")).orders.map((x) => x.id), [paid.id, held.id]);
  await ledgerHolds(o);
});

test("tenancy and roles", async () => {
  const o = await crmOwner();
  const other = await crmOwner("Aziz", "Other shop");
  const agentOnly = await owner();
  const p = await product(o, { opening: 5 });
  const c = await customer(o);
  const ord = (await order(o, { customerId: c, lines: [{ productId: p.id, qty: 1 }] })).changes.set.orders[0];
  const theirs = await product(other, { opening: 5 });
  const theirC = await customer(other);

  // Another workspace's ids read as "not found", whichever way they come in.
  const x = other.b;
  const w = other.crm;
  assert.equal((await x.call("PUT", `${w}/products/${p.id}`, { name: "Mine now" })).status, 404);
  assert.equal((await x.call("DELETE", `${w}/products/${p.id}`)).status, 404);
  assert.equal((await x.call("POST", `${w}/stock/receive`, { lines: [{ productId: p.id, qty: 1 }] })).status, 404);
  assert.equal((await x.call("POST", `${w}/stock/receive`, { lines: [{ variantId: p.variants[0].id, qty: 1 }] })).status, 404);
  assert.equal((await x.call("POST", `${w}/stock/write-off`, { variantId: p.variants[0].id, qty: 1, reason: "lost" })).status, 404);
  assert.equal((await x.call("POST", `${w}/stock/count`, { variantId: p.variants[0].id, counted: 0 })).status, 404);
  assert.equal((await x.call("POST", `${w}/orders`, { customerId: theirC, lines: [{ variantId: p.variants[0].id, qty: 1 }], delivery: { type: "pickup" } })).status, 404);
  assert.equal((await x.call("POST", `${w}/orders`, { customerId: c, lines: [{ productId: theirs.id, qty: 1 }], delivery: { type: "pickup" } })).body.code, "bad_customer");
  for (const [method, path, body] of [["PUT", "", { note: "x" }], ["POST", "/step", { to: "confirmed" }], ["POST", "/cancel", {}], ["POST", "/pay", {}], ["POST", "/refund", {}], ["DELETE", "", undefined], ["GET", "/receipt", undefined]]) {
    assert.equal((await x.call(method, `${w}/orders/${ord.id}${path}`, body)).status, 404, `${method} ${path}`);
  }
  assert.equal((await x.call("PUT", `${w}/orders/${ord.id}`, { customerId: theirC })).status, 404);
  // Nor can they reach into this workspace at all, and nothing of it shows in theirs.
  assert.equal((await x.call("GET", `${o.crm}/snapshot`)).status, 404);
  assert.equal((await x.call("POST", `${o.crm}/orders/${ord.id}/step`, { to: "confirmed" })).status, 404);
  const mine = await snap(other);
  assert.deepEqual([mine.products.map((y) => y.id), mine.orders, mine.movements.length], [[theirs.id], [], 1]);
  assert.deepEqual(await stockOf(o, p.id), [5, 0]);
  // Signed out, or a workspace without the CRM.
  assert.equal((await browser().call("POST", `${o.crm}/orders/${ord.id}/step`, { to: "confirmed" })).status, 401);
  const off = await agentOnly.b.call("POST", `/w/${agentOnly.ws.id}/crm/products`, { name: "X" });
  assert.deepEqual([off.status, off.body.code], [404, "product_off"]);

  // A team member does the daily work; deleting and refunds are for admins.
  const mate = await teammate(o, "agent");
  const admin = await teammate(o, "admin", "Aziza Admin");
  const made = ok(await mate.b.call("POST", `${o.crm}/products`, { name: "Made by a team member", opening: 1 }), 201);
  ok(await mate.b.call("PUT", `${o.crm}/products/${made.id}`, { price: 5 }));
  const theirOrder = ok(await mate.b.call("POST", `${o.crm}/orders`, { customerId: c, lines: [{ productId: p.id, qty: 1 }], delivery: { type: "pickup" }, paid: true }), 201).id;
  ok(await mate.b.call("POST", `${o.crm}/orders/${theirOrder}/step`, { to: "confirmed" }));
  ok(await mate.b.call("PUT", `${o.crm}/orders/${theirOrder}`, { note: "By Sherzod" }));
  ok(await mate.b.call("GET", `${o.crm}/orders/${theirOrder}/receipt`));
  for (const [method, path, body] of [["DELETE", `/orders/${ord.id}`], ["POST", `/orders/${theirOrder}/refund`, {}], ["DELETE", `/products/${p.id}`]]) {
    assert.equal((await mate.b.call(method, o.crm + path, body)).status, 403, path);
  }
  ok(await admin.b.call("POST", `${o.crm}/orders/${theirOrder}/refund`, { amount: 1 }));
  ok(await admin.b.call("DELETE", `${o.crm}/orders/${ord.id}`));

  // A deleted workspace takes its store with it, ledger and all.
  await query("DELETE FROM workspaces WHERE id = $1", [other.ws.id]);
  assert.equal((await query("SELECT (SELECT count(*) FROM crm_products WHERE workspace_id = $1) + (SELECT count(*) FROM crm_stock_moves WHERE workspace_id = $1) + (SELECT count(*) FROM crm_stock WHERE workspace_id = $1) AS n", [other.ws.id])).rows[0].n, "0");
  await ledgerHolds(o);
});

test("the last item: of two orders at once, exactly one gets it", async () => {
  const o = await crmOwner();
  const mate = { b: (await teammate(o, "agent")).b, crm: o.crm };
  const p = await product(o, { name: "Last bouquet", opening: 1 });
  const v = p.variants[0].id;
  const c = await customer(o);
  const make = async () => (await order(o, { customerId: c, lines: [{ productId: p.id, qty: 1 }] })).changes.set.orders[0].id;
  const short = { status: 422, code: "rules", hard: [{ code: "short", variantId: v, productId: p.id, name: "Last bouquet", need: 1, free: 0, missing: 1 }], soft: [] };

  for (let round = 0; round < 6; round++) {
    // Even rounds race to hold it, odd rounds race to sell it straight from the shelf.
    const to = round % 2 ? "delivered" : "confirmed";
    const [a, b, d] = [await make(), await make(), await make()];
    const results = await Promise.all([step(o, a, to), step(mate, b, to), step(o, d, to)]);
    const won = results.filter((r) => r.status === 200);
    const lost = results.filter((r) => r.status !== 200);
    assert.equal(won.length, 1, `round ${round}: exactly one order gets the last item (${results.map((r) => r.status)})`);
    for (const r of lost) assert.deepEqual(rules(r), short, `round ${round}: the others are told what is short`);
    assert.deepEqual(await stockOf(o, p.id), to === "confirmed" ? [1, 1] : [0, 0]);
    await ledgerHolds(o);
    // Put the item back for the next round: let it go, or receive a new one.
    const winner = [a, b, d][results.indexOf(won[0])];
    if (to === "confirmed") ok(await o.b.call("POST", `${o.crm}/orders/${winner}/cancel`, {}));
    else ok(await o.b.call("POST", `${o.crm}/stock/receive`, { lines: [{ productId: p.id, qty: 1 }] }));
    assert.deepEqual(await stockOf(o, p.id), [1, 0]);
  }

  // An edit and a write-off race for it too.
  const held = await make();
  ok(await step(o, held, "confirmed"));
  ok(await o.b.call("POST", `${o.crm}/stock/receive`, { lines: [{ productId: p.id, qty: 1 }] }));
  const both = await Promise.all([o.b.call("PUT", `${o.crm}/orders/${held}`, { lines: [{ productId: p.id, qty: 2 }] }), mate.b.call("POST", `${o.crm}/stock/write-off`, { productId: p.id, qty: 1, reason: "damaged" })]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 422]);
  await ledgerHolds(o);
});

test("live updates: the store's tables announce their snapshot keys", async () => {
  const o = await crmOwner();
  const other = await crmOwner("Aziz", "Other shop");
  const s = await openStream(`${o.crm}/stream`, o.b.cookie);
  const quiet = await openStream(`${other.crm}/stream`, other.b.cookie);
  try {
    await s.next((e) => e.event === "ready");
    await quiet.next((e) => e.event === "ready");
    const keysAfter = async (act, want) => {
      s.events.length = 0;
      await act();
      const end = Date.now() + 3000;
      const seen = new Set();
      while (Date.now() < end && !want.every((k) => seen.has(k))) {
        for (const e of s.events) if (e.event === "crm") for (const k of e.data.k) seen.add(k);
        await new Promise((r) => setTimeout(r, 20));
      }
      for (const k of want) assert.ok(seen.has(k), `"${k}" was announced (got ${[...seen]})`);
    };
    let p;
    await keysAfter(async () => (p = await product(o, { opening: 3 })), ["products", "movements"]);
    const c = await customer(o);
    let id;
    await keysAfter(async () => (id = (await order(o, { customerId: c, lines: [{ productId: p.id, qty: 1 }] })).id), ["orders"]);
    await keysAfter(async () => ok(await step(o, id, "confirmed")), ["orders", "products"]);
    await keysAfter(async () => ok(await o.b.call("POST", `${o.crm}/orders/${id}/pay`, { amount: 1 })), ["orders"]);
    await keysAfter(async () => ok(await step(o, id, "delivered")), ["orders", "products", "movements"]);
    await keysAfter(async () => ok(await o.b.call("PUT", `${o.crm}/products/${p.id}`, { price: 7 })), ["products"]);
    assert.equal(quiet.events.filter((e) => e.event === "crm").length, 0, "another workspace hears nothing");
  } finally {
    s.close();
    quiet.close();
  }
});

/* ───── Found in review ───── */

test("a finished order's money stays as it was settled: its delivery fee can't change", async () => {
  const o = await crmOwner();
  const p = await product(o, { price: 100000, opening: 9 });
  const c = await customer(o);
  const put = (id, body) => o.b.call("PUT", `${o.crm}/orders/${id}`, body);
  const make = async (delivery) => (await order(o, { customerId: c, lines: [{ productId: p.id, qty: 1 }], ...(delivery ? { delivery } : {}) })).id;

  // Handed over and paid: pickup to courier would make it owe the fee, courier to pickup would leave money to refund.
  const pick = await make();
  ok(await step(o, pick, "delivered"));
  assert.deepEqual(rules(await put(pick, { delivery: { type: "courier", address: "Main st 1" } })).hard, [{ code: "lines_locked" }]);
  const cour = await make({ type: "courier", address: "Main st 1" });
  ok(await step(o, cour, "delivered"));
  assert.deepEqual(rules(await put(cour, { delivery: { type: "pickup" } })).hard, [{ code: "lines_locked" }]);
  // What doesn't touch the money can still be corrected.
  const fixed = ok(await put(cour, { delivery: { address: "Main st 2" } })).changes.set.orders[0];
  assert.deepEqual([fixed.delivery.address, fixed.totals.total, fixed.totals.balance, fixed.paid], ["Main st 2", 130000, 0, true]);
  // A cancelled order is closed the same way.
  const off = await make();
  ok(await o.b.call("POST", `${o.crm}/orders/${off}/cancel`, {}));
  assert.deepEqual(rules(await put(off, { delivery: { type: "courier", address: "Main st 1" } })).hard, [{ code: "lines_locked" }]);
  // While the order is being worked on, the method and its fee change freely.
  const open = await make();
  assert.equal(ok(await put(open, { delivery: { type: "courier", address: "Main st 1" } })).changes.set.orders[0].totals.fee, 30000);
});

test("an edit that leaves out a line's price or discount keeps them", async () => {
  const o = await crmOwner();
  const p = await product(o, { price: 100000, opening: 9 });
  const c = await customer(o);
  const put = (id, body) => o.b.call("PUT", `${o.crm}/orders/${id}`, body);
  const made = (await order(o, { customerId: c, lines: [{ productId: p.id, qty: 2, price: 90000, discount: 20000 }] })).changes.set.orders[0];
  const v = made.lines[0].variantId;
  assert.equal(made.totals.total, 160000);
  const more = ok(await put(made.id, { lines: [{ variantId: v, qty: 3 }] })).changes.set.orders[0];
  assert.deepEqual([more.lines.map((l) => [l.qty, l.price, l.discount]), more.totals.total], [[[3, 90000, 20000]], 250000]);
  // The same variant on two lines: each line keeps its own.
  ok(await put(made.id, { lines: [{ variantId: v, qty: 1, price: 80000, discount: 1000 }, { variantId: v, qty: 2, price: 90000, discount: 0 }] }));
  const two = ok(await put(made.id, { lines: [{ variantId: v, qty: 1 }, { variantId: v, qty: 2 }] })).changes.set.orders[0];
  assert.deepEqual(two.lines.map((l) => [l.qty, l.price, l.discount]), [[1, 80000, 1000], [2, 90000, 0]]);
  // A kept discount still can't be more than the line it is on.
  assert.equal((await put(made.id, { lines: [{ variantId: v, qty: 1 }, { variantId: v, qty: 1, discount: 90001 }] })).body.code, "bad_discount");
  // Finished: the app sends the lines back the demo's way (no discount) together with a note.
  ok(await step(o, made.id, "delivered"));
  const noted = ok(await put(made.id, { note: "Left at the door", lines: two.lines.map(({ variantId, qty, price }) => ({ variantId, qty, price })) })).changes.set.orders[0];
  assert.deepEqual([noted.note, noted.totals.total], ["Left at the door", 259000]);
  // One order, the same variant on two lines: the Stock page lists one sale per line, as the demo does.
  const { movements } = await snap(o, "movements");
  assert.deepEqual(movements.filter((m) => m.orderId === made.id).map((m) => [m.type, m.qty]), [["sale", -2], ["sale", -1]]);
  await ledgerHolds(o);
});

test("an order's money stays a safe whole number", async () => {
  const o = await crmOwner();
  const big = await product(o, { price: 1e12, opening: 1_000_000 });
  const c = await customer(o);
  // The goods of one order may come to 10^15 soʻm at most: every sum stays exact in JS and in BIGINT.
  const most = (await order(o, { customerId: c, lines: [{ productId: big.id, qty: 1000 }], paid: true })).changes.set.orders[0];
  assert.deepEqual([most.totals.total, most.totals.balance, most.paid], [1e15, 0, true]);
  const { rows } = await query("SELECT (SELECT sum(qty::numeric * price - discount) FROM crm_order_lines WHERE order_id = $1)::text AS exact, (SELECT sum(amount) FROM crm_payments WHERE order_id = $1)::text AS paid", [most.id]);
  assert.deepEqual(rows[0], { exact: "1000000000000000", paid: "1000000000000000" });
  const tooBig = { status: 400, code: "order_too_large", max: 1e15 };
  const r1 = await o.b.call("POST", `${o.crm}/orders`, { customerId: c, lines: [{ productId: big.id, qty: 999999 }], delivery: { type: "pickup" }, paid: true });
  assert.deepEqual({ status: r1.status, code: r1.body.code, max: r1.body.max }, tooBig);
  const r2 = await o.b.call("POST", `${o.crm}/orders`, { customerId: c, lines: Array.from({ length: 10 }, () => ({ productId: big.id, qty: 1_000_000 })), delivery: { type: "pickup" }, paid: true });
  assert.deepEqual({ status: r2.status, code: r2.body.code, max: r2.body.max }, tooBig);
  // Edits are held to it too.
  const r3 = await o.b.call("PUT", `${o.crm}/orders/${most.id}`, { lines: [{ productId: big.id, qty: 1001 }] });
  assert.deepEqual({ status: r3.status, code: r3.body.code, max: r3.body.max }, tooBig);
  assert.equal((await query("SELECT count(*)::int AS n FROM crm_orders WHERE workspace_id = $1", [o.ws.id])).rows[0].n, 1, "nothing was saved for the refused ones");
});

test("stock counters go past what a 32-bit number holds", async () => {
  const o = await crmOwner();
  const p = await product(o, { price: 1 });
  const lines = Array.from({ length: 200 }, () => ({ productId: p.id, qty: 1_000_000 }));
  for (let i = 0; i < 11; i++) ok(await o.b.call("POST", `${o.crm}/stock/receive`, { lines }));
  assert.deepEqual(await stockOf(o, p.id), [2_200_000_000, 0]);
  const c = await customer(o);
  const id = (await order(o, { customerId: c, lines: [{ productId: p.id, qty: 1_000_000 }] })).id;
  const held = ok(await step(o, id, "confirmed")).changes.set.products[0];
  assert.deepEqual([held.stock, held.reserved, held.variants[0].stock], [2_200_000_000, 1_000_000, 2_200_000_000]);
  const kept = await o.b.call("DELETE", `${o.crm}/products/${p.id}`);
  assert.deepEqual([kept.status, kept.body.stock], [409, 2_200_000_000]);
  // A count can say what such a shelf holds, as receipts can raise it.
  const counted = ok(await o.b.call("POST", `${o.crm}/stock/count`, { productId: p.id, counted: 2_150_000_000 }));
  assert.deepEqual([counted.diff, counted.changes.set.products[0].stock], [-50_000_000, 2_150_000_000]);
  assert.equal((await o.b.call("POST", `${o.crm}/stock/count`, { productId: p.id, counted: Number.MAX_SAFE_INTEGER + 2 })).status, 400);
  await ledgerHolds(o);
});

test("stock never grows past what the app is sent exactly: per branch, and for the product as a whole", async () => {
  const o = await crmOwner();
  const MAX = Number.MAX_SAFE_INTEGER;
  const tooMuch = (r) => assert.deepEqual(rules(r), { status: 422, code: "rules", hard: [{ code: "qty_too_large" }], soft: [] });
  const onHand = async (variantId) => (await query("SELECT sum(on_hand)::text AS n FROM crm_stock WHERE variant_id = $1", [variantId])).rows[0].n;
  const p = await product(o, { price: 1, opening: 1 });
  const v = p.variants[0].id;
  // A count can say the most there is; nothing can be brought in on top of it.
  assert.equal(ok(await o.b.call("POST", `${o.crm}/stock/count`, { productId: p.id, counted: MAX })).changes.set.products[0].stock, MAX);
  tooMuch(await o.b.call("POST", `${o.crm}/stock/receive`, { lines: [{ productId: p.id, qty: 2 }] }));
  assert.equal(await onHand(v), String(MAX));
  // The next count sees the real number, so it writes no wrong difference.
  assert.deepEqual(rules(await o.b.call("POST", `${o.crm}/stock/count`, { productId: p.id, counted: MAX })).hard, [{ code: "no_difference", variantId: v, productId: p.id, name: "Roses" }]);
  // Each branch's shelf within the limit is not enough: the product's stock is them added up.
  const B = ok(await o.b.call("POST", `${o.crm}/branches`, { name: "Chilonzor" }), 201).id;
  tooMuch(await o.b.call("POST", `${o.crm}/stock/count`, { productId: p.id, counted: 5, branchId: B }));
  tooMuch(await o.b.call("POST", `${o.crm}/stock/receive`, { lines: [{ productId: p.id, qty: 1 }], branchId: B }));
  // So are a product's variants: the second one can't take the product past it.
  const t = ok(await o.b.call("POST", `${o.crm}/products`, { name: "T-shirt", options: [{ id: "size", name: "Size", values: ["S", "M"] }], variants: [{ values: { size: "S" }, price: 1 }, { values: { size: "M" }, price: 1 }] }), 201).changes.set.products[0];
  ok(await o.b.call("POST", `${o.crm}/stock/count`, { variantId: t.variants[0].id, counted: MAX - 1 }));
  ok(await o.b.call("POST", `${o.crm}/stock/receive`, { lines: [{ variantId: t.variants[1].id, qty: 1 }] }));
  tooMuch(await o.b.call("POST", `${o.crm}/stock/receive`, { lines: [{ variantId: t.variants[1].id, qty: 1 }] }));
  assert.equal(ok(await o.b.call("GET", `${o.crm}/snapshot?only=products`)).products.find((x) => x.id === t.id).stock, MAX);
  // Going down is never refused for it.
  ok(await o.b.call("POST", `${o.crm}/stock/count`, { variantId: t.variants[0].id, counted: 0 }));
  await ledgerHolds(o);
});

test("goods that come back to a variant taken off the product", async () => {
  const o = await crmOwner();
  const c = await customer(o);
  const options = [{ id: "size", name: "Size", values: ["S", "M"] }];
  const shirt = async () => ok(await o.b.call("POST", `${o.crm}/products`, { name: "Shirt", options, variants: [{ values: { size: "S" }, price: 1000, opening: 1 }, { values: { size: "M" }, price: 1000 }] }), 201).changes.set.products[0];
  const sell = async (v) => {
    const id = (await order(o, { customerId: c, lines: [{ variantId: v, qty: 1 }] })).id;
    ok(await step(o, id, "delivered"));
    return id;
  };

  // S sold out and taken off the product; then the customer brings it back.
  const p = await shirt();
  const [S, M] = p.variants;
  const sold = await sell(S.id);
  const off = ok(await o.b.call("PUT", `${o.crm}/products/${p.id}`, { variants: [{ id: M.id }] })).changes.set.products[0];
  assert.equal(off.variants.find((v) => v.id === S.id).archived, true);
  const back = ok(await o.b.call("POST", `${o.crm}/orders/${sold}/cancel`, {})).changes.set.products[0];
  const s = back.variants.find((v) => v.id === S.id);
  assert.deepEqual([s.archived, s.stock, back.stock], [undefined, 1, 1], "the returned S is on the product again");
  assert.equal((await order(o, { customerId: c, lines: [{ variantId: S.id, qty: 1 }] })).changes.set.orders[0].lines[0].variantId, S.id, "and can be sold");

  // The product has a new S of its own by now: the old one stays put away, and its shelf can still be counted.
  const q = await shirt();
  const [S1, M1] = q.variants;
  const sold1 = await sell(S1.id);
  ok(await o.b.call("PUT", `${o.crm}/products/${q.id}`, { variants: [{ id: M1.id }, { values: { size: "S" }, price: 1200 }] }));
  const back1 = ok(await o.b.call("POST", `${o.crm}/orders/${sold1}/cancel`, {})).changes.set.products[0];
  assert.deepEqual([back1.variants.find((v) => v.id === S1.id).archived, back1.variants.filter((v) => !v.archived).length], [true, 2]);
  const counted = ok(await o.b.call("POST", `${o.crm}/stock/count`, { variantId: S1.id, counted: 0, note: "Back to the supplier" }));
  assert.deepEqual([counted.diff, counted.changes.set.products[0].stock], [-1, 0]);
  assert.equal((await o.b.call("POST", `${o.crm}/stock/receive`, { lines: [{ variantId: S1.id, qty: 1 }] })).body.code, "variant_archived", "it takes no new stock");
  await ledgerHolds(o);
});

test("product pictures: never removed while a product shows them; unused uploads are cleaned up", async () => {
  const o = await crmOwner();
  const png = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(40, 3)]);
  const upload = async () => {
    const f = new FormData();
    f.append("file", new Blob([png]), "x.png");
    return ok(await o.b.call("POST", `${o.crm}/products/images`, f), 201).image;
  };
  const shows = async (path) => (await fetch(base + path, { headers: { Cookie: o.b.cookie } })).status;

  // One edit takes a picture off a product while another write puts it on a new one, at the same moment.
  for (let round = 0; round < 5; round++) {
    const x = await upload();
    const p = await product(o, { image: x });
    const [took, made] = await Promise.all([o.b.call("PUT", `${o.crm}/products/${p.id}`, { image: "" }), o.b.call("POST", `${o.crm}/products`, { name: "Twin", image: x })]);
    ok(took);
    // Either the new product got the picture and it is still there, or the picture was gone first and the save was refused.
    if (made.status === 201) assert.equal(await shows(x), 200, `round ${round}: a picture a product shows is never removed`);
    else assert.deepEqual([made.status, made.body.code], [400, "bad_image"], `round ${round}`);
  }
  for (const p of (await snap(o, "products")).products) if (p.image) assert.equal(await shows(p.image), 200, "every product's picture is there");

  // An upload no product took is removed a day later; one a product shows stays.
  const stale = await upload();
  const kept = await upload();
  await product(o, { image: kept });
  await query("UPDATE crm_product_images SET created_at = now() - interval '2 days' WHERE workspace_id = $1", [o.ws.id]);
  const fresh = await upload();
  assert.deepEqual([await shows(stale), await shows(kept), await shows(fresh)], [404, 200, 200]);
  // A picture that was removed can't be put on a product.
  const late = await o.b.call("POST", `${o.crm}/products`, { name: "Late", image: stale });
  assert.deepEqual([late.status, late.body.code], [400, "bad_image"]);
});

test("editing an order checks the shelf of the order's own branch", async () => {
  const o = await crmOwner();
  const p = await product(o, { opening: 5 });
  const c = await customer(o);
  const id = (await order(o, { customerId: c, lines: [{ productId: p.id, qty: 1 }] })).id;
  ok(await step(o, id, "confirmed"));
  // Another branch becomes the default; the order and the goods it holds stay where they are.
  await query("UPDATE crm_branches SET is_default = false WHERE workspace_id = $1", [o.ws.id]);
  await query("INSERT INTO crm_branches (workspace_id, name, is_default) VALUES ($1, 'Second', true)", [o.ws.id]);
  const more = ok(await o.b.call("PUT", `${o.crm}/orders/${id}`, { lines: [{ productId: p.id, qty: 3 }] })).changes.set;
  assert.deepEqual([more.products[0].stock, more.products[0].reserved], [5, 3]);
  await ledgerHolds(o);
});

test("a customer's own order asks for at most LEFT_CAP of a thing, however its lines are split; the team's is not capped", async () => {
  const o = await crmOwner();
  const p = await product(o, { opening: 37 });
  const v = p.variants[0].id;
  const c = await customer(o);
  const asCustomer = { by: "customer", via: "ai", source: "ai", capped: true };
  const make = (lines) => createOrder(o.ws.id, asCustomer, { customerId: c, lines, delivery: { type: "pickup" } }).then((r) => ({ status: 201, body: r }), (e) => ({ status: e.status, body: e.extra }));
  const tooMany = { status: 422, code: "rules", hard: [{ code: "too_many", variantId: v, productId: p.id, max: LEFT_CAP }], soft: [] };
  // Past the cap is refused before the stock is asked, so the answer never tells how many are left.
  for (const lines of [[{ productId: p.id, variantId: v, qty: LEFT_CAP + 1 }], [{ productId: p.id, variantId: v, qty: 6 }, { productId: p.id, variantId: v, qty: 6 }], [{ productId: p.id, variantId: v, qty: 999 }]]) {
    assert.deepEqual(rules(await make(lines)), tooMany, JSON.stringify(lines));
  }
  assert.deepEqual((await snap(o, "orders")).orders, []);
  assert.equal((await make([{ productId: p.id, variantId: v, qty: LEFT_CAP }])).status, 201);
  // The team sells as much as is on the shelf.
  ok(await step(o, (await order(o, { customerId: c, lines: [{ productId: p.id, qty: 27 }] })).id, "confirmed"));
});
