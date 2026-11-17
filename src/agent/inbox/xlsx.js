// Reads the cell text out of an .xlsx file: a ZIP of XML parts. Just enough of ZIP for that
// (stored and deflated entries); every entry is capped, so a "zip bomb" can't fill memory.
import zlib from "node:zlib";
import * as cheerio from "cheerio";

const MAX_ENTRY = 20 * 1024 * 1024;

/** The ZIP's entries as { name → () => Buffer }. Throws on anything that isn't a ZIP. */
function unzip(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const entries = new Map();
  for (let n = 0; n < count && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const skip = nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    entries.set(name, () => {
      if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("bad zip entry");
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY });
      throw new Error("unsupported zip compression");
    });
    p += 46 + skip;
  }
  return entries;
}

const xml = (entries, name) => (entries.has(name) ? cheerio.load(entries.get(name)().toString("utf8"), { xml: true }) : null);

/** Every sheet as "Sheet name" followed by its rows, cells separated by " | ". */
export function xlsxToText(buf, maxChars = 20000) {
  const entries = unzip(buf);
  const shared = [];
  xml(entries, "xl/sharedStrings.xml")?.("si").each((_, si) => {
    const $ = cheerio.load(si, { xml: true });
    shared.push($("t").map((__, t) => $(t).text()).get().join(""));
  });
  // Sheet names and files, in the workbook's order.
  const rels = new Map();
  xml(entries, "xl/_rels/workbook.xml.rels")?.("Relationship").each((_, r) => {
    rels.set(r.attribs.Id, r.attribs.Target.replace(/^\/?(xl\/)?/, "xl/"));
  });
  const book = xml(entries, "xl/workbook.xml");
  const sheets = book
    ? book("sheet").map((_, s) => ({ name: s.attribs.name, file: rels.get(s.attribs["r:id"]) })).get().filter((s) => s.file && entries.has(s.file))
    : [...entries.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort().map((file, i) => ({ name: `Sheet ${i + 1}`, file }));

  let out = "";
  for (const sheet of sheets) {
    const $ = xml(entries, sheet.file);
    const rows = [];
    $("sheetData > row").each((_, row) => {
      const cells = [];
      $(row).children("c").each((__, c) => {
        const t = c.attribs.t;
        const v = $(c).children("v").text();
        const value = t === "s" ? shared[Number(v)] ?? "" : t === "inlineStr" ? $(c).find("t").text() : t === "b" ? (v === "1" ? "TRUE" : "FALSE") : v;
        if (value.trim()) cells.push(value.trim());
      });
      if (cells.length) rows.push(cells.join(" | "));
    });
    if (rows.length) out += `${out ? "\n\n" : ""}${sheet.name}\n${rows.join("\n")}`;
    if (out.length >= maxChars) break;
  }
  return out.slice(0, maxChars);
}
