// Excel export and import through the API: exports read back, the round trip (export, import,
// nothing changes), every reason a row is skipped, a row twice in one file, previews that are
// another workspace's, another person's, used, expired or out of date, roles, the file limits, and
// 5,000 rows applied in a fixed number of queries.
import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { crmOwner, teammate, base, query } from "./helpers/setup.js";
import { addDays, dayOf, nowIn } from "../src/crm/shared/time.js";
import { readSheet, writeBook } from "../src/crm/exchange/xlsx.js";
import { readZip, writeZip } from "../src/crm/exchange/zip.js";

const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const D = (n) => addDays(dayOf(nowIn("Asia/Tashkent", new Date())), n);
const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, ["00:00", "24:00"]]));
const LIMITS = { maxRows: 20000, maxCols: 100, maxCell: 5000 };

/** Downloads an export: { status, type, name, rows }. */
async function download(o, path, b = o.b) {
  const res = await fetch(`${base}${o.crm}/export/${path}`, { headers: { Cookie: b.cookie, "CF-Connecting-IP": "198.51.100.40" } });
  const buf = Buffer.from(await res.arrayBuffer());
  if (res.status !== 200) return { status: res.status };
  return { status: 200, type: res.headers.get("content-type"), name: res.headers.get("content-disposition"), buf, rows: readSheet(buf, LIMITS).map((r) => r.cells) };
}
/** Sends a file to an import's preview. */
const preview = (o, kind, buf, b = o.b) => {
  const form = new FormData();
  form.append("file", new Blob([buf]), "file.xlsx");
  return b.call("POST", `${o.crm}/import/${kind}`, form);
};
const apply = (o, token, b = o.b) => b.call("POST", `${o.crm}/import/apply`, { token });
const book = (header, rows) => writeBook([{ name: "Sheet", header, rows }]);
const snap = async (o, only) => ok(await o.b.call("GET", `${o.crm}/snapshot?only=${only}`));
const post = async (o, path, body, status = 201) => ok(await o.b.call("POST", o.crm + path, body), status);
const reasons = (p) => p.skip.map((s) => [s.row, s.code]);

/** A workspace with customer fields of every kind, two tags, customers, products with and without options. */
async function shop() {
  const o = await crmOwner();
  ok(await o.b.call("PUT", `${o.crm}/settings`, {
    modules: { booking: true, store: true },
    tags: [{ id: "vip", name: "VIP", tone: "amber" }, { id: "new", name: { en: "Newcomer", ru: "Новичок", uz: "Yangi mijoz" }, tone: "" }],
    fields: { customer: [
      { id: "bday", name: { en: "Birthday", ru: "День рождения", uz: "Tugʻilgan kun" }, type: "date" },
      { id: "kids", name: "Kids", type: "number" },
      { id: "news", name: { en: "Wants news", ru: "Рассылка", uz: "Yangiliklar" }, type: "yesno" },
      { id: "size", name: "Size", type: "choice", options: ["S", "M", "L"] },
    ] },
    productCategories: [{ id: "flowers", name: { en: "Flowers", ru: "Цветы", uz: "Gullar" } }],
  }));
  o.c1 = (await post(o, "/customers", { name: "Jasur Karimov", phone: "+998901234567", telegram: "@jasur_k", source: "telegram", tags: ["vip", "new"], note: "Line one\nline two", fields: { bday: "1990-05-01", kids: 2, news: true, size: "M" } })).id;
  o.c2 = (await post(o, "/customers", { name: "Malika", source: "phone", fields: { news: false } })).id;
  o.c3 = (await post(o, "/customers", { name: "Dilnoza Aliyeva", phone: "+998935550000", instagram: "dilnoza" })).id;
  o.roses = (await post(o, "/products", { name: "Roses", sku: "R-1", category: "flowers", price: 100000, cost: 60000, lowAt: 3, opening: 20 })).id;
  o.tulips = (await post(o, "/products", {
    name: "Tulips",
    options: [{ id: "c", name: "Colour", values: ["Red", "White"] }],
    variants: [{ values: { c: "Red" }, sku: "T-R", price: 30000, cost: 10000, opening: 5 }, { values: { c: "White" }, price: 40000 }],
  })).id;
  return o;
}

test("export: customers and products read back in the language asked for", async () => {
  const o = await shop();
  const en = await download(o, "customers.xlsx?lang=en");
  assert.equal(en.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.match(en.name, /attachment; filename="customers-\d{4}-\d{2}-\d{2}\.xlsx"/);
  assert.deepEqual(en.rows[0], ["Name", "Phone", "Telegram", "Instagram", "Source", "Tags", "Note", "Birthday", "Kids", "Wants news", "Size", "Added", "ID"]);
  const jasur = en.rows.find((r) => r[0] === "Jasur Karimov");
  assert.deepEqual(jasur.slice(0, 11), ["Jasur Karimov", "+998901234567", "jasur_k", "", "Telegram", "VIP, Newcomer", "Line one\nline two", "1990-05-01", "2", "Yes", "M"]);
  assert.equal(jasur[12], o.c1);
  const ru = await download(o, "customers.xlsx?lang=ru");
  assert.deepEqual(ru.rows[0].slice(0, 8), ["Имя", "Телефон", "Telegram", "Instagram", "Источник", "Теги", "Заметка", "День рождения"]);
  assert.equal(ru.rows.find((r) => r[0] === "Malika")[4], "Звонок");

  const products = await download(o, "products.xlsx?lang=uz");
  assert.deepEqual(products.rows[0], ["Mahsulot", "Variant", "Artikul", "Kategoriya", "Oʻlchov birligi", "Narx", "Tannarx", "Kam qoldiq chegarasi", "Sotuvda", "Qoldiq", "Buyurtmalarga ajratilgan", "ID"]);
  // One row per variant; numbers are numbers.
  assert.deepEqual(products.rows.slice(1).map((r) => r.slice(0, 10)), [
    ["Tulips", "Red", "T-R", "", "dona", "30000", "10000", "0", "Ha", "5"],
    ["Tulips", "White", "", "", "dona", "40000", "0", "0", "Ha", "0"],
    ["Roses", "", "R-1", "Gullar", "dona", "100000", "60000", "3", "Ha", "20"],
  ]);
});

test("round trip: export then import changes nothing, in any language", async () => {
  const o = await shop();
  const before = await snap(o, "customers,products,movements");
  for (const [kind, lang] of [["customers", "en"], ["customers", "ru"], ["customers", "uz"], ["products", "en"], ["products", "ru"]]) {
    const file = await download(o, `${kind}.xlsx?lang=${lang}`);
    const p = ok(await preview(o, kind, file.buf));
    assert.deepEqual([p.add.length, p.update.length, p.skip.length, p.unchanged], [0, 0, 0, kind === "customers" ? 3 : 3], `${kind} ${lang}: ${JSON.stringify(p)}`);
    assert.equal(p.ignored.length, 0, `${kind} ${lang}: every column is known`);
    const done = ok(await apply(o, p.token));
    assert.deepEqual([done.added, done.updated, done.changes], [0, 0, {}]);
  }
  assert.deepEqual(await snap(o, "customers,products,movements"), { ...before, rev: (await snap(o, "customers")).rev });
});

test("customers: preview says what would happen and saves nothing; apply does exactly that", async () => {
  const o = await shop();
  const header = ["Name", "Phone", "Source", "Tags", "Note", "Birthday", "Kids", "Size", "ID", "Colour of car"];
  const rows = [
    ["Aziz New", "90 111 22 33", "Instagram", "vip", "", "01.02.2000", "1", "s", "", "red"], // 2: new (a date as people type it, a choice in any case)
    ["Jasur Karimov", "+998 90 123 45 67", "telegram", "VIP; Newcomer", "Called", "", "3", "", "", ""], // 3: found by phone: note, kids and birthday change
    ["", "90 999 00 00", "", "", "", "", "", "", "", ""], // 4: no name for a new customer
    ["Bad Phone", "12345", "", "", "", "", "", "", "", ""], // 5
    ["Malika", "+998935550000", "", "", "", "", "", "", o.c2, ""], // 6: Dilnoza's phone on Malika
    ["Twin", "90 111 22 33", "", "", "", "", "", "", "", ""], // 7: the same phone as row 2
    ["Odd Source", "", "Pigeon", "", "", "", "", "", "", ""], // 8
    ["Odd Tag", "", "", "Gold", "", "", "", "", "", ""], // 9
    ["Odd Field", "", "", "", "", "not a day", "", "", "", ""], // 10
    ["Long", "", "", "", "x".repeat(2001), "", "", "", "", ""], // 11
    ["Ghost", "", "", "", "", "", "", "", "00000000-0000-4000-8000-000000000000", ""], // 12
    ["Dilnoza Aliyeva", "+998935550000", "", "", "", "", "", "", o.c3, ""], // 13: nothing changes
    ["No Phone Person", "", "", "", "", "", "", "XL", "", ""], // 14: not one of the choices
  ];
  const p = ok(await preview(o, "customers", book(header, rows)));
  assert.equal(p.rows, 13);
  assert.deepEqual(p.columns.map((c) => [c.column, c.key]), [["A", "name"], ["B", "phone"], ["C", "source"], ["D", "tags"], ["E", "note"], ["F", "field:bday"], ["G", "field:kids"], ["H", "field:size"], ["I", "id"]]);
  assert.deepEqual(p.ignored, [{ column: "J", header: "Colour of car" }]);
  assert.deepEqual(p.add, [{ row: 2, name: "Aziz New" }]);
  assert.deepEqual(p.update.map((u) => [u.row, u.id, u.changes.sort()]), [[3, o.c1, ["fields", "note"]]]);
  assert.equal(p.unchanged, 1);
  assert.deepEqual(reasons(p), [[4, "no_name"], [5, "bad_phone"], [6, "phone_taken"], [7, "duplicate"], [8, "bad_source"], [9, "bad_tag"], [10, "bad_fields"], [11, "too_long"], [12, "unknown_id"], [14, "bad_fields"]]);
  assert.deepEqual(p.skip.find((s) => s.row === 6), { row: 6, code: "phone_taken", customerId: o.c3 });
  assert.deepEqual(p.skip.find((s) => s.row === 7), { row: 7, code: "duplicate", first: 2 });
  assert.deepEqual(p.skip.find((s) => s.row === 10).fields, { bday: "bad_value" });
  assert.deepEqual(p.skip.find((s) => s.row === 11), { row: 11, code: "too_long", column: "note" });
  assert.match(p.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  // Nothing was saved.
  assert.equal((await snap(o, "customers")).customers.length, 3);

  const done = ok(await apply(o, p.token));
  assert.deepEqual([done.kind, done.added, done.updated], ["customers", 1, 1]);
  assert.equal(typeof done.rev, "number");
  const after = (await snap(o, "customers")).customers;
  assert.equal(after.length, 4);
  const aziz = after.find((c) => c.name === "Aziz New");
  assert.deepEqual([aziz.phone, aziz.source, aziz.tags, aziz.fields], ["+998901112233", "instagram", ["vip"], { bday: "2000-02-01", kids: 1, size: "S" }]);
  const jasur = after.find((c) => c.id === o.c1);
  // An empty cell clears its field; the columns the file doesn't have stay as they were.
  assert.deepEqual([jasur.note, jasur.fields, jasur.telegram], ["Called", { kids: 3, news: true }, "jasur_k"]);
  assert.deepEqual(done.changes.set.customers.map((c) => c.id).sort(), [aziz.id, o.c1].sort());

  // A preview works once.
  assert.equal((await apply(o, p.token)).body.code, "preview_used");
});

test("products: preview, every skip reason, apply with opening stock", async () => {
  const o = await shop();
  const s = await snap(o, "products");
  const white = s.products.find((p) => p.id === o.tulips).variants[1];
  const header = ["Product", "Variant", "SKU", "Category", "Unit", "Price", "Cost", "Low stock at", "On sale", "Stock", "ID"];
  const rows = [
    ["Vase", "", "V-1", "", "kg", "20 000", "5000", "1", "no", "7", ""], // 2: new, with opening stock
    ["Roses", "", "r-1", "Цветы", "", "110000", "", "", "", "999", ""], // 3: found by SKU in any case; the stock is not touched
    ["Bowl", "", "B-1", "", "barrel", "", "", "", "", "", ""], // 4
    ["Plate", "", "P-1", "Kitchen", "", "", "", "", "", "", ""], // 5
    ["Cup", "", "C-1", "", "", "abc", "", "", "", "", ""], // 6
    ["Shirt", "M", "SH-M", "", "", "", "", "", "", "", ""], // 7: a new product with options
    ["Vase again", "", "v-1", "", "", "", "", "", "", "", ""], // 8: the same SKU as row 2
    ["Tulips", "White", "T-R", "", "", "", "", "", "", "", white.id], // 9: White would take the red tulips' SKU
    ["Tulips", "Red", "T-R", "", "", "31000", "", "", "", "", ""], // 10: changes the red tulips' price
    ["Tulpen", "White", "", "", "", "", "", "", "", "", white.id], // 11: renames the product row 10 kept as Tulips
    ["Ghost", "", "", "", "", "", "", "", "", "", "00000000-0000-4000-8000-000000000000"], // 12
    ["", "", "N-1", "", "", "", "", "", "", "", ""], // 13: a new product needs a name
    ["Spoon", "", "S-1", "", "", "", "", "", "maybe", "", ""], // 14
  ];
  const p = ok(await preview(o, "products", book(header, rows)));
  assert.deepEqual(p.add, [{ row: 2, name: "Vase", sku: "V-1" }]);
  assert.deepEqual(p.update.map((u) => [u.row, u.productId, u.changes.sort()]), [[3, o.roses, ["price", "sku"]], [10, o.tulips, ["price"]]]);
  assert.deepEqual(reasons(p), [[4, "bad_unit"], [5, "bad_category"], [6, "bad_value"], [7, "options_new"], [8, "duplicate"], [9, "sku_taken"], [11, "product_conflict"], [12, "unknown_id"], [13, "no_name"], [14, "bad_value"]]);
  assert.deepEqual(p.skip.find((x) => x.row === 6), { row: 6, code: "bad_value", column: "price" });
  assert.deepEqual(p.skip.find((x) => x.row === 11), { row: 11, code: "product_conflict", first: 10 });
  assert.deepEqual(p.skip.find((x) => x.row === 14), { row: 14, code: "bad_value", column: "onSale" });
  assert.equal((await snap(o, "products")).products.length, 2, "nothing saved");

  const done = ok(await apply(o, p.token));
  assert.deepEqual([done.added, done.updated], [1, 2]);
  const after = (await snap(o, "products,movements"));
  const vase = after.products.find((x) => x.name === "Vase");
  assert.deepEqual([vase.sku, vase.unit, vase.price, vase.cost, vase.lowAt, vase.onSale, vase.stock, vase.options], ["V-1", "kg", 20000, 5000, 1, false, 7, []]);
  const roses = after.products.find((x) => x.id === o.roses);
  assert.deepEqual([roses.sku, roses.price, roses.cost, roses.stock], ["r-1", 110000, 60000, 20]);
  assert.equal(after.products.find((x) => x.id === o.tulips).variants[0].price, 31000);
  const receipt = after.movements.find((m) => m.productId === vase.id);
  assert.deepEqual([receipt.type, receipt.qty, receipt.note.en], ["receipt", 7, "Opening stock"]);
  assert.deepEqual(done.changes.set.movements.map((m) => m.id), [receipt.id]);
  assert.equal(done.changes.set.products.length, 3);
});

test("previews: another workspace's, another person's, expired and out of date are refused", async () => {
  const o = await shop();
  const file = book(["Name", "Phone"], [["Sardor", "90 700 00 01"]]);
  const mine = ok(await preview(o, "customers", file));

  const other = await crmOwner("Other Owner", "Other");
  assert.deepEqual([(await apply(other, mine.token)).status, (await apply(other, mine.token)).body.code], [404, "preview_not_found"]);
  const admin = await teammate(o, "admin", "Second Admin");
  assert.equal((await apply(o, mine.token, admin.b)).body.code, "preview_not_found");
  assert.equal((await apply(o, "x".repeat(32))).body.code, "preview_not_found");

  // Someone adds the same phone after the preview: the same file would now change a customer, not add one.
  await post(o, "/customers", { name: "Sardor B", phone: "+998907000001" });
  const stale = await apply(o, mine.token);
  assert.deepEqual([stale.status, stale.body.code], [409, "preview_stale"]);
  assert.equal((await snap(o, "customers")).customers.filter((c) => c.phone === "+998907000001").length, 1);

  const late = ok(await preview(o, "customers", book(["Name"], [["Late"]])));
  await query("UPDATE crm_imports SET expires_at = now() - interval '1 minute' WHERE workspace_id = $1", [o.ws.id]);
  assert.deepEqual([(await apply(o, late.token)).status, (await apply(o, late.token)).body.code], [410, "preview_expired"]);
  // The other workspace's own previews work for it.
  const theirs = ok(await preview(other, "customers", book(["Ism", "Telefon"], [["Bobur", "90 700 00 02"]])));
  assert.equal(ok(await apply(other, theirs.token)).added, 1);
});

test("roles: only admins and the owner export and import", async () => {
  const o = await shop();
  const mate = await teammate(o, "agent");
  for (const path of ["customers.xlsx", "products.xlsx", `bookings.xlsx?from=${D(0)}&to=${D(1)}`, `orders.xlsx?from=${D(0)}&to=${D(1)}`]) {
    assert.equal((await download(o, path, mate.b)).status, 403, path);
  }
  assert.equal((await preview(o, "customers", book(["Name"], [["X"]]), mate.b)).status, 403);
  const p = ok(await preview(o, "customers", book(["Name"], [["X"]])));
  assert.equal((await apply(o, p.token, mate.b)).status, 403);
  const admin = await teammate(o, "admin", "Admin Two");
  assert.equal((await download(o, "customers.xlsx", admin.b)).status, 200);
});

test("files: not a spreadsheet, too large, too many rows, unknown columns, formulas and shared text", async () => {
  const o = await shop();
  const r1 = await preview(o, "customers", Buffer.from("name,phone\nA,1\n"));
  assert.deepEqual([r1.status, r1.body.code], [400, "bad_file"]);
  const big = await preview(o, "customers", Buffer.alloc(5 * 1024 * 1024 + 1, 65));
  assert.deepEqual([big.status, big.body.code], [413, "file_too_large"]);
  const many = await preview(o, "customers", book(["Name"], Array.from({ length: 10001 }, (_, i) => [`P${i}`])));
  assert.deepEqual([many.status, many.body.code, many.body.max], [413, "too_many_rows", 10000]);
  const none = await preview(o, "customers", book(["Colour", "Size"], [["red", "M"]]));
  assert.deepEqual([none.status, none.body.code], [400, "no_columns"]);
  const empty = await preview(o, "customers", book(["Name"], []));
  assert.deepEqual([empty.status, empty.body.code], [400, "no_rows"]);
  const noFile = await o.b.call("POST", `${o.crm}/import/customers`, new FormData());
  assert.deepEqual([noFile.status, noFile.body.code], [400, "bad_file"]);

  // A file the way spreadsheet programs write it: shared strings, a formula (its saved value is read, never run), a yes/no cell, a gap.
  const shared = ["Name", "Telefon", "Kids", "Wants news", "Formula person"];
  const xml = (s) => `<?xml version="1.0" encoding="UTF-8"?>${s}`;
  const file = writeZip([
    { name: "[Content_Types].xml", data: xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
    { name: "xl/workbook.xml", data: xml('<x:workbook xmlns:x="m" xmlns:r="r"><x:sheets><x:sheet name="One" sheetId="1" r:id="rId7"/></x:sheets></x:workbook>') },
    { name: "xl/_rels/workbook.xml.rels", data: xml('<Relationships><Relationship Id="rId7" Target="/xl/worksheets/data.xml"/></Relationships>') },
    { name: "xl/sharedStrings.xml", data: xml(`<sst>${shared.map((t) => `<si><r><t>${t.slice(0, 3)}</t></r><r><t>${t.slice(3)}</t></r><rPh><t>ignored</t></rPh></si>`).join("")}</sst>`) },
    {
      name: "xl/worksheets/data.xml",
      data: xml(`<x:worksheet xmlns:x="m"><x:sheetData>
        <x:row r="3"><x:c r="A3" t="s"><x:v>0</x:v></x:c><x:c r="B3" t="s"><x:v>1</x:v></x:c><x:c r="D3" t="s"><x:v>2</x:v></x:c><x:c r="E3" t="s"><x:v>3</x:v></x:c></x:row>
        <x:row r="5"><x:c r="A5" t="s"><x:v>4</x:v></x:c><x:c r="B5"><x:v>998901230000</x:v></x:c><x:c r="D5"><x:f>1+1</x:f><x:v>2</x:v></x:c><x:c r="E5" t="b"><x:v>1</x:v></x:c></x:row>
      </x:sheetData></x:worksheet>`),
    },
  ]);
  const p = ok(await preview(o, "customers", file));
  assert.deepEqual(p.columns.map((c) => [c.column, c.key]), [["A", "name"], ["B", "phone"], ["D", "field:kids"], ["E", "field:news"]]);
  assert.deepEqual(p.add, [{ row: 5, name: "Formula person" }]);
  ok(await apply(o, p.token));
  const added = (await snap(o, "customers")).customers.find((c) => c.name === "Formula person");
  assert.deepEqual([added.phone, added.fields], ["+998901230000", { kids: 2, news: true }]);
});

/** A book from its raw parts: the first sheet, and shared strings or a workbook when given. */
const rawBook = ({ sheet, strings, workbook }) =>
  writeZip([
    ...(workbook ? [{ name: "xl/workbook.xml", data: workbook }] : []),
    ...(strings ? [{ name: "xl/sharedStrings.xml", data: strings }] : []),
    { name: "xl/worksheets/sheet1.xml", data: sheet },
  ]);
/** What reading a book gives: its rows' cells, or the refusal's code. */
const outcome = (buf, limits = LIMITS) => {
  try {
    return readSheet(buf, limits).map((r) => r.cells);
  } catch (e) {
    return e.code;
  }
};

test("files: a sheet whose rows, cells or texts never close is read in one pass and refused", async () => {
  const n = 200000;
  const sheet = (data) => `<worksheet><sheetData>${data}</sheetData></worksheet>`;
  const good = sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c></row>');
  const cases = [
    [{ sheet: sheet("<row>".repeat(n)) }, "bad_file"],
    [{ sheet: sheet(`<row>${"<c>".repeat(n)}</row>`) }, "bad_file"],
    [{ sheet: sheet(`<row><c t="inlineStr"><is>${"<t>".repeat(n)}</is></c></row>`) }, "bad_file"],
    [{ sheet: sheet(`<row><c>${"<v>".repeat(n)}</c></row>`) }, "bad_file"],
    [{ sheet: sheet(`<row><c t="inlineStr"><is><t>a</t>${"<rPh>".repeat(n)}</is></c></row>`) }, "bad_file"],
    [{ sheet: sheet(`<row>${"<x:c".repeat(n)}</row>`) }, []], // "<" that never ends a tag is text between tags
    [{ sheet: `<worksheet><sheetData>${"<".repeat(n)}` }, []],
    [{ sheet: sheet(`<row r="1"><c r="A1" a${'="'.repeat(n)}/></row>`) }, []],
    [{ sheet: sheet(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`), strings: `<sst>${"<si><t>".repeat(n)}</sst>` }, "bad_file"],
    [{ sheet: sheet(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`), strings: `<sst><si>${"<rPh>".repeat(n)}</si></sst>` }, "bad_file"],
    [{ sheet: good, workbook: `<workbook><sheets>${"<sheet r:id=".repeat(n)}</sheets></workbook>` }, [["Name"]]],
  ];
  for (const [i, [parts, want]] of cases.entries()) {
    const buf = rawBook(parts);
    const t = Date.now();
    assert.deepEqual(outcome(buf), want, `case ${i}`);
    assert.ok(Date.now() - t < 1000, `case ${i}: ${Date.now() - t} ms`);
  }

  // Through the API: a 1 KB file answers at once, and the server keeps answering others meanwhile.
  const o = await shop();
  const file = rawBook({ sheet: sheet("<row>".repeat(160000)) });
  assert.ok(file.length < 4000, `${file.length} bytes`);
  const t = Date.now();
  const r = await preview(o, "customers", file);
  assert.deepEqual([r.status, r.body.code], [400, "bad_file"]);
  assert.ok(Date.now() - t < 1500, `${Date.now() - t} ms`);
});

test("files: text that shared strings repeat past the total is refused before anything is stored", async () => {
  const o = await shop();
  const heads = ["Name", "Phone", "Telegram", "Instagram", "Source", "Tags", "Note", "Added", "ID"];
  const letter = (i) => String.fromCharCode(65 + i);
  // 10,000 rows whose every cell points at one shared text of 1,000 characters: 90 million characters from a small file.
  const strings = `<sst>${heads.map((h) => `<si><t>${h}</t></si>`).join("")}<si><t>${"x".repeat(1000)}</t></si></sst>`;
  let data = `<row r="1">${heads.map((h, i) => `<c r="${letter(i)}1" t="s"><v>${i}</v></c>`).join("")}</row>`;
  for (let r = 2; r <= 10001; r++) data += `<row r="${r}">${heads.map((h, i) => `<c r="${letter(i)}${r}" t="s"><v>${heads.length}</v></c>`).join("")}</row>`;
  const file = rawBook({ sheet: `<worksheet><sheetData>${data}</sheetData></worksheet>`, strings });
  assert.ok(file.length < 300 * 1024, `${file.length} bytes`);
  const t = Date.now();
  const r = await preview(o, "customers", file);
  assert.deepEqual([r.status, r.body.code, r.body.max], [413, "too_much_text", 10000000]);
  assert.ok(Date.now() - t < 3000, `${Date.now() - t} ms`);
  const { rows } = await query("SELECT count(*)::int AS n FROM crm_imports WHERE workspace_id = $1", [o.ws.id]);
  assert.equal(rows[0].n, 0);
  // Every character kept counts, however few bytes stood for it: a total of three rows' text is passed on the fourth.
  assert.equal(outcome(file, { ...LIMITS, maxText: 1000 * 9 * 3 + 100 }), "too_much_text");
});

test("files: text that looks like Excel's own escapes, or any character XML can carry, comes back as it was", async () => {
  const tricky = ["_x0041_", "_x005F_x0041_", "a_x000D_b", "_x00e9_", " and �", "😀 Тест ʻ", "=1+1", "<b>&amp;</b>", "a\nb"];
  const back = outcome(book(["Text"], tricky.map((t) => [t])));
  assert.deepEqual(back.slice(1).map((r) => r[0]), tricky);
  // Characters XML can't carry are left out.
  assert.deepEqual(outcome(book(["Text"], [["a\u0001b￾c"]]))[1], ["abc"]);

  // Through the app: a customer's note with such text survives export and import untouched.
  const o = await shop();
  const id = (await post(o, "/customers", { name: "Escape Person", note: "_x0041_ " })).id;
  const file = await download(o, "customers.xlsx");
  assert.equal(file.rows.find((r) => r[0] === "Escape Person")[6], "_x0041_ ");
  const p = ok(await preview(o, "customers", file.buf));
  assert.deepEqual([p.add.length, p.update.length, p.skip.length, p.unchanged], [0, 0, 0, 4]);
  assert.equal((await snap(o, "customers")).customers.find((c) => c.id === id).note, "_x0041_ ");
});

test("products: rows of one product's variants that change different product fields all apply", async () => {
  const o = await shop();
  const s = await snap(o, "products");
  const tulips = s.products.find((p) => p.id === o.tulips);
  assert.deepEqual([tulips.unit, tulips.onSale], ["pcs", true]);
  // An empty unit or on-sale cell keeps the field, so the rows agree: the first changes the unit, the second takes the product off sale.
  const p = ok(await preview(o, "products", book(["SKU", "Unit", "On sale", "ID"], [["T-R", "kg", "", ""], ["", "", "No", tulips.variants[1].id]])));
  assert.deepEqual(p.update.map((u) => [u.row, u.changes]), [[2, ["unit"]], [3, ["onSale"]]]);
  assert.deepEqual(p.skip, []);
  ok(await apply(o, p.token));
  const after = (await snap(o, "products")).products.find((x) => x.id === o.tulips);
  assert.deepEqual([after.unit, after.onSale], ["kg", false]);
});

test("export: bookings and orders of a span of days, with the order panels' sums", async () => {
  const o = await shop();
  const s1 = (await post(o, "/services", { name: { en: "Haircut", ru: "Стрижка", uz: "Soch olish" }, duration: 30, price: 50000 })).id;
  const p1 = (await post(o, "/staff", { name: "Aziz", hours: ALL_DAY, serviceIds: [s1] })).id;
  await post(o, "/appointments", { customerId: o.c1, staffId: p1, serviceIds: [s1], start: `${D(1)}T10:00` });
  await post(o, "/appointments", { customerId: o.c2, staffId: p1, serviceIds: [s1], start: `${D(3)}T10:00`, price: 45000 });
  const b = await download(o, `bookings.xlsx?from=${D(1)}&to=${D(2)}&lang=ru`);
  assert.equal(b.rows.length, 2);
  assert.deepEqual(b.rows[0].slice(0, 9), ["Начало", "Минуты", "Клиент", "Телефон", "Специалист", "Услуги", "Этап", "Цена", "Оплачено"]);
  assert.deepEqual(b.rows[1].slice(0, 9), [`${D(1)} 10:00`, "30", "Jasur Karimov", "+998901234567", "Aziz", "Стрижка", "Подтверждена", "50000", "Нет"]);

  const red = (await snap(o, "products")).products.find((p) => p.id === o.tulips).variants[0];
  const made = await post(o, "/orders", { customerId: o.c1, lines: [{ productId: o.roses, qty: 2, discount: 10000 }, { variantId: red.id, qty: 1 }], discount: 5000, delivery: { type: "courier", address: "Chilonzor 9" } });
  ok(await o.b.call("POST", `${o.crm}/orders/${made.id}/pay`, { amount: 100000 }));
  const file = await download(o, `orders.xlsx?from=${D(0)}&to=${D(0)}`);
  const [head, row] = file.rows;
  const col = (name) => row[head.indexOf(name)];
  assert.deepEqual([col("Items"), col("Goods"), col("Discount"), col("Delivery fee"), col("Total"), col("Paid"), col("Owed"), col("Delivery"), col("Address")],
    ["Roses x 2, Tulips (Red) x 1", "220000", "5000", "30000", "245000", "100000", "145000", "Courier", "Chilonzor 9"]);
  const order = (await snap(o, "orders")).orders.find((x) => x.id === made.id);
  assert.equal(Number(col("Total")), order.totals.total);
  // The book's second sheet holds the lines.
  const second = readZip(file.buf).get("xl/worksheets/sheet2.xml")().toString("utf8");
  assert.match(second, /Tulips.*Red.*T-R/s);
  assert.equal((await download(o, `orders.xlsx?from=${D(1)}&to=${D(2)}`)).rows.length, 1, "only the header outside the span");
  const backwards = await o.b.call("GET", `${o.crm}/export/orders.xlsx?from=${D(2)}&to=${D(1)}`);
  assert.deepEqual([backwards.status, backwards.body.issues[0].params.code], [400, "bad_span"]);
});

test("5,000 rows: previewed and applied in a fixed number of queries", async () => {
  const o = await shop();
  const rows = Array.from({ length: 5000 }, (_, i) => [`Person ${i}`, `+99897${String(1000000 + i).padStart(7, "0")}`, i % 2 ? "VIP" : "", String(i % 5)]);
  const file = book(["Name", "Phone", "Tags", "Kids"], rows);
  let count = 0;
  const real = pg.Client.prototype.query;
  pg.Client.prototype.query = function counted(...args) {
    count++;
    return real.apply(this, args);
  };
  let p;
  let done;
  try {
    p = ok(await preview(o, "customers", file));
    const previewQueries = count;
    count = 0;
    done = ok(await apply(o, p.token));
    // The counter sees the server's queries (they run in this process): a few, never one per row.
    assert.ok(previewQueries > 3 && previewQueries < 25, `preview: ${previewQueries} queries`);
    assert.ok(count > 3 && count < 25, `apply: ${count} queries`);
  } finally {
    pg.Client.prototype.query = real;
  }
  assert.deepEqual([p.add.length, p.skip.length], [5000, 0]);
  assert.equal(done.added, 5000);
  assert.equal(done.changes.set.customers.length, 5000);
  const { rows: stored } = await query("SELECT count(*)::int AS n, count(*) FILTER (WHERE tags = '{vip}')::int AS vip FROM crm_customers WHERE workspace_id = $1 AND name LIKE 'Person %'", [o.ws.id]);
  assert.deepEqual(stored[0], { n: 5000, vip: 2500 });
  // The same file again: every row is found by its phone and nothing changes.
  const again = ok(await preview(o, "customers", file));
  assert.deepEqual([again.add.length, again.update.length, again.unchanged], [0, 0, 5000]);
});
