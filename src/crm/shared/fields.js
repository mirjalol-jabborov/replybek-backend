// Custom fields: the extra details a business keeps on its customers, bookings and orders.
// defs: db.fields.customer (etc.) = [{ id, name, type, options?, required?, card? }];
// values live on the item: item.fields = { [fieldId]: value }.

export const FIELD_TYPES = ["text", "number", "date", "time", "choice", "yesno"];

const empty = (v) => v === undefined || v === null || v === "";
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A real calendar day written "2026-11-17". */
export function isDay(v) {
  const m = typeof v === "string" && DAY.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
/** A time written "09:30". */
export const isHm = (v) => typeof v === "string" && HM.test(v);

/** Whether two stored values (text, a list, a name, a fields object) are the same, whatever order an object's keys come in. */
export const same = (a, b) =>
  a && typeof a === "object" && b && typeof b === "object" ? Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => same(a[k], b[k])) : a === b;

/** Required fields that are still empty: [{ id, name, … }]. `only`: check just these field ids. */
export const missingFields = (defs, values, only) => (defs || []).filter((d) => (only ? only.includes(d.id) : d.required) && (d.type === "yesno" ? values?.[d.id] !== true && only : empty(values?.[d.id])));

/** Whether a new value fits a field's type. */
function fits(def, v) {
  if (def.type === "yesno") return typeof v === "boolean";
  if (def.type === "number") return typeof v === "number" && Number.isFinite(v);
  if (def.type === "date") return isDay(v);
  if (def.type === "time") return isHm(v);
  if (def.type === "choice") return typeof v === "string" && (def.options || []).includes(v);
  return typeof v === "string" && v.length <= 2000;
}

/**
 * Checks the field values someone sent against the workspace's fields.
 * Returns { values, errors }: `values` is what to store, `errors` = { [fieldId]: "bad_value" }.
 * An empty value ("" or null) clears the field. A value equal to the stored one always passes:
 * forms send every field back, and one typed before its field changed (a choice taken off the
 * list, a text field turned into a date) must not block saving the rest. Values of fields that were
 * removed from the settings are kept as stored (removing a field hides it, it doesn't lose what
 * was typed), and nothing new can be written under an unknown id.
 */
export function cleanFields(defs, sent, stored = {}) {
  const values = { ...stored };
  const errors = {};
  if (sent === null || typeof sent !== "object" || Array.isArray(sent)) return { values, errors: { "": "bad_value" } };
  for (const def of defs || []) {
    if (!(def.id in sent)) continue;
    const v = sent[def.id];
    if (empty(v)) delete values[def.id];
    else if (v === stored[def.id]) continue;
    else if (fits(def, v)) values[def.id] = typeof v === "string" && def.type === "text" ? v.trim() : v;
    else errors[def.id] = "bad_value";
  }
  return { values, errors };
}
