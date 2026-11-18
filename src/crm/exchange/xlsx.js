// Spreadsheets in and out. Reading takes the first sheet of an .xlsx as rows of text cells, each
// in its column: every cell is text (a number is its digits, a yes/no cell TRUE or FALSE), and a
// formula is never run (its last saved value is read, as text). Writing makes a plain .xlsx:
// text as inline strings (so nothing in a cell can ever act as a formula), numbers as numbers,
// a bold header row that stays in view.
import { readZip, writeZip, ZipError } from "./zip.js";

export class SheetError extends Error {
  constructor(code, extra) {
    super(code);
    this.code = code;
    this.extra = extra;
  }
}

/* ───── Reading ───── */
// One pass over the XML from start to end, never back: each tag is found by scanning for its "<"
// and ">" once, so the time grows with the file whatever is in it (a lazy regex looking for a
// closing tag that never comes scans to the end again for every opening one). An element the
// reader follows (row, c, v, si, t, rPh) that opens inside itself or never closes is bad_file.

const ENTITY = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
// Characters XML 1.0 can't carry, and the "_x000D_" escapes Excel writes for them.
const point = (n) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "");
const decode = (s) =>
  s
    .replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => (e[0] === "#" ? point(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITY[e.toLowerCase()]))
    .replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
const ATTR = new Map();
const attr = (attrs, name) => {
  if (!ATTR.has(name)) ATTR.set(name, new RegExp(`(?:^|\\s)(?:\\w+:)?${name}="([^"]*)"`));
  return ATTR.get(name).exec(attrs)?.[1];
};
/** "C" → 2, "AA" → 26. */
const columnIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
/** 2 → "C". */
export const columnName = (i) => (i < 26 ? String.fromCharCode(65 + i) : columnName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));

const bad = () => new SheetError("bad_file");
// From a "<" to the next ">" with no "<" between, so no character is scanned more than twice.
const TAG = /<([^<>]*)>/g;
// Anchored at both ends, so one pass over the tag: "/" (closing), a prefix ("x:"), the name, the attributes, "/" (empty).
const PARTS = /^(\/?)(?:[\w.-]+:)?([A-Za-z][\w.-]*)([\s\S]*?)(\/?)$/;

/**
 * Every tag in order: { name (without its prefix), close, empty, attrs, start, text }. `text()`
 * is what stands between the tag before and this one (the text of a <t> or <v>, at its closing tag).
 * Declarations and comments are not tags here.
 */
function* tags(xml) {
  let last = 0;
  for (const m of xml.matchAll(TAG)) {
    const p = PARTS.exec(m[1]);
    if (!p) continue;
    const from = last;
    last = m.index + m[0].length;
    yield { name: p[2], close: p[1] === "/", empty: p[4] === "/", attrs: p[3], text: () => xml.slice(from, m.index) };
  }
}

/** The text of runs of <t> (in an <si> or an <is>), leaving out phonetic hints (<rPh>), cut at `limit` characters. */
class Runs {
  constructor(limit) {
    this.limit = limit;
    this.reset();
  }
  reset() {
    this.parts = [];
    this.length = 0;
    this.inText = false;
    this.phonetic = false;
  }
  /** Takes in one tag inside the runs. */
  tag(t) {
    if (t.empty || (t.name !== "t" && t.name !== "rPh")) return;
    const open = t.name === "t" ? this.inText : this.phonetic;
    if (t.close !== open) throw bad();
    if (t.name === "rPh") this.phonetic = !t.close;
    else {
      this.inText = !t.close;
      if (t.close && !this.phonetic && this.length <= this.limit) {
        const text = t.text();
        this.parts.push(text);
        this.length += text.length;
      }
    }
  }
  /** The runs' text, and starts again. */
  done() {
    if (this.inText || this.phonetic) throw bad();
    const text = decode(this.parts.join("")).slice(0, this.limit);
    this.reset();
    return text;
  }
}

function entry(entries, name) {
  const read = entries.get(name);
  return read ? read().toString("utf8") : null;
}

/** The first sheet's part in the archive. */
function firstSheet(entries) {
  const book = entry(entries, "xl/workbook.xml");
  const rels = entry(entries, "xl/_rels/workbook.xml.rels");
  const sheet = book && /<(?:\w+:)?sheet\b([^<>]*)>/.exec(book);
  const rid = sheet && attr(sheet[1], "id");
  if (rid && rels) {
    for (const m of rels.matchAll(/<(?:\w+:)?Relationship\b([^<>]*)>/g)) {
      if (attr(m[1], "Id") === rid) {
        const target = (attr(m[1], "Target") || "").replace(/^\/?(xl\/)?/, "xl/");
        if (entries.has(target)) return target;
      }
    }
  }
  return [...entries.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()[0] || null;
}

/** The shared strings table: the text of every <si>, each cut at `limit` characters. */
function sharedStrings(xml, limit) {
  const list = [];
  const runs = new Runs(limit);
  let open = false;
  for (const t of tags(xml)) {
    if (t.name !== "si") {
      if (open) runs.tag(t);
    } else if (t.empty) list.push("");
    else {
      if (t.close !== open) throw bad();
      if (t.close) list.push(runs.done());
      open = !t.close;
    }
  }
  if (open) throw bad();
  return list;
}

/**
 * The first sheet as [{ n (the sheet's own row number), cells: [text] }], rows with nothing in
 * them left out. Limits: `maxRows` rows, `maxCols` columns, `maxCell` characters in a cell, and
 * `maxText` characters kept in all (shared strings let a few bytes stand for a long text in every
 * cell, so the file's size alone doesn't bound what it holds).
 * Throws SheetError("bad_file") for anything that isn't an .xlsx, ("too_many_rows", { max }),
 * ("too_much_text", { max }).
 */
export function readSheet(buf, { maxRows, maxCols, maxCell, maxText = Infinity }) {
  let xml;
  let shared = [];
  try {
    const entries = readZip(buf);
    const name = firstSheet(entries);
    if (!name) throw bad();
    xml = entry(entries, name);
    const strings = entry(entries, "xl/sharedStrings.xml");
    if (strings) shared = sharedStrings(strings, maxCell + 1);
  } catch (e) {
    if (e instanceof ZipError) throw bad();
    throw e;
  }
  const rows = [];
  const runs = new Runs(maxCell + 1);
  let kept = 0;
  let next = 1;
  let row = null; // { n, cells, col }: the row open now
  let cell = null; // { at, type, v, inValue }: the cell open now

  const endCell = () => {
    if (cell.inValue) throw bad();
    let text;
    if (cell.type === "inlineStr") text = runs.done();
    else if (cell.type === "s") text = shared[Number(cell.v)] ?? "";
    else if (cell.type === "b") text = cell.v === "1" ? "TRUE" : "FALSE";
    else text = cell.v === undefined ? "" : decode(cell.v);
    text = text.replace(/\r\n?/g, "\n").trim();
    if (text && cell.at < maxCols) {
      text = text.slice(0, maxCell + 1);
      kept += text.length;
      if (kept > maxText) throw new SheetError("too_much_text", { max: maxText });
      row.cells[cell.at] = text;
    }
    cell = null;
  };
  const endRow = () => {
    if (row.cells.some(Boolean)) {
      if (rows.length >= maxRows) throw new SheetError("too_many_rows", { max: maxRows - 1 });
      rows.push({ n: row.n, cells: Array.from(row.cells, (x) => x || "") });
    }
    row = null;
  };

  for (const t of tags(xml)) {
    if (t.name === "row") {
      if (cell || (t.close ? !row : row)) throw bad();
      if (t.close) endRow();
      else {
        const n = Number(attr(t.attrs, "r")) || next;
        next = n + 1;
        if (!t.empty) row = { n, cells: [], col: 0 };
      }
    } else if (t.name === "c") {
      if (!row || (t.close ? !cell : cell)) throw bad();
      if (t.close) endCell();
      else {
        const ref = attr(t.attrs, "r");
        const at = ref ? columnIndex(/^[A-Z]+/.exec(ref)?.[0] || "A") : row.col;
        row.col = at + 1;
        cell = { at, type: attr(t.attrs, "t"), v: undefined, inValue: false };
        if (t.empty) endCell();
      }
    } else if (!cell) continue;
    else if (t.name === "v") {
      // The cell's value. A formula (<f>) beside it is never read: the value is the one last saved.
      if (t.empty) cell.v = "";
      else if (t.close !== cell.inValue || (!t.close && cell.v !== undefined)) throw bad();
      else {
        if (t.close) cell.v = t.text();
        cell.inValue = !t.close;
      }
    } else if (cell.type === "inlineStr") runs.tag(t);
  }
  if (row) throw bad();
  return rows;
}

/* ───── Writing ───── */

// Characters XML 1.0 can't carry are dropped; the rest is escaped.
const esc = (s) => String(s).replace(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "").replace(/[<>&"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[ch]);
// A cell's text: Excel reads "_x0041_" in it as the character it names, so text that looks like
// that keeps its underscore escaped ("_x005F_x0041_"), the way Excel writes it, and reads back as it was.
// Every such underscore, even one that ends another sequence ("_x005F_x0041_" itself).
const escText = (s) => esc(String(s).replace(/_(?=x[0-9A-Fa-f]{4}_)/g, "_x005F_"));

function cell(ref, value, style) {
  const s = style ? ` s="${style}"` : "";
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
  if (value === null || value === undefined || value === "") return "";
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escText(value)}</t></is></c>`;
}

function sheetXml({ header, rows }) {
  const widths = header.map((h, i) => Math.min(60, Math.max(8, String(h).length, ...rows.slice(0, 200).map((r) => String(r[i] ?? "").length)) + 2));
  const line = (values, n, style) => `<row r="${n}">${values.map((v, i) => cell(`${columnName(i)}${n}`, v, style)).join("")}</row>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>
<sheetData>${line(header, 1, 1)}${rows.map((r, i) => line(r, i + 2)).join("")}</sheetData>
</worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
</styleSheet>`;

/** An .xlsx of these sheets: [{ name, header: [text], rows: [[text | number | null]] }]. */
export function writeBook(sheets) {
  const n = sheets.map((_, i) => i + 1);
  // A sheet's name: at most 31 characters, none of : \ / ? * [ ].
  const title = (s) => esc(String(s.name).replace(/[:\\/?*[\]]/g, " ").slice(0, 31));
  return writeZip([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${n.map((i) => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${title(s)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${n.map((i) => `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: "xl/styles.xml", data: STYLES },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ]);
}
