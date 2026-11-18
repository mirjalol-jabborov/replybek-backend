// From a sheet's text cells to what a form would send, and back: which column is which, list
// items found by their id or any of their names, field values by their type. An import checks
// what comes out of here with the same rules the team's forms use.
import { columnName } from "./xlsx.js";
import { plain, spellings, readYesNo, yesNo, L } from "./words.js";

/**
 * The header row against the columns a kind knows ([{ key, words: [spellings] }]): which column is
 * which, the ones it doesn't know, and each data row as { n, values: { [key]: text } }.
 * A column named twice counts once, the first time.
 */
export function recognise(rows, known) {
  const [head, ...data] = rows;
  const byWord = new Map();
  for (const col of known) for (const w of col.words) if (!byWord.has(plain(w))) byWord.set(plain(w), col.key);
  const columns = [];
  const ignored = [];
  (head?.cells || []).forEach((text, i) => {
    if (!text) return;
    const key = byWord.get(plain(text));
    if (key && !columns.some((c) => c.key === key)) columns.push({ column: columnName(i), header: text, key, index: i });
    else ignored.push({ column: columnName(i), header: text });
  });
  return {
    columns: columns.map(({ index, ...c }) => c),
    ignored,
    rows: data.map((r) => ({ n: r.n, values: Object.fromEntries(columns.map((c) => [c.key, r.cells[c.index] || ""])) })),
  };
}

/** An item of a settings list by its id or any of its names: its id, "" for an empty cell, undefined when none fits. `kept`: a stored id that stays valid. */
export function findInList(list, text, kept) {
  const t = plain(text);
  if (!t) return "";
  const hit = (list || []).find((x) => plain(x.id) === t || spellings(x.name).some((s) => plain(s) === t));
  if (hit) return hit.id;
  return kept && plain(kept) === t ? kept : undefined;
}

/** A list item's name for a cell: its name in the language, or its id when the list no longer has it. */
export const listName = (list, id, lang) => {
  const hit = (list || []).find((x) => x.id === id);
  return hit ? L(hit.name, lang) : id || "";
};

/** Several items in one cell, separated by commas or semicolons: their ids, or { bad: text } for the first that fits none. */
export function findAllInList(list, text) {
  const ids = [];
  for (const part of String(text || "").split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
    const id = findInList(list, part);
    if (!id) return { bad: part };
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids };
}

/** A number as people type it: spaces between thousands and a decimal comma are fine. NaN when it isn't one. */
export const readNumber = (text) => {
  const t = String(text).replace(/[\s\u00a0]/g, "").replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
};

const DMY = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/;
/**
 * A custom field's cell as the value a form would send: text, a number, "2026-11-17", "09:30",
 * one of the choices, true or false. An empty cell clears the field (null). A value that can't be
 * its type is passed on as it is, so the shared check refuses it.
 */
export function readField(def, text) {
  if (!text) return null;
  if (def.type === "number") return Number.isNaN(readNumber(text)) ? text : readNumber(text);
  if (def.type === "yesno") return readYesNo(text) ?? text;
  if (def.type === "date") {
    const m = DMY.exec(text);
    return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : text;
  }
  if (def.type === "time") return /^\d:\d\d$/.test(text) ? `0${text}` : text;
  if (def.type === "choice") return (def.options || []).find((o) => plain(o) === plain(text)) ?? text;
  return text;
}

/** A custom field's value for a cell. */
export function fieldCell(def, value, lang) {
  if (value === undefined || value === null || value === "") return "";
  if (def.type === "yesno") return yesNo(value === true, lang);
  if (def.type === "number" && typeof value === "number") return value;
  return String(value);
}

/**
 * A zod refusal of one row as a skip reason: { code: "no_name" } for a missing name,
 * { code: "too_long", column } for text past its limit, else { code: "bad_value", column }.
 */
export function shapeReason(error, nameKey = "name") {
  const issue = error.issues[0];
  const column = String(issue.path[0] ?? "");
  if (column === nameKey && (issue.code === "too_small" || issue.code === "invalid_type")) return { code: "no_name" };
  if (issue.code === "too_big" && issue.type === "string") return { code: "too_long", column };
  return { code: "bad_value", column };
}
