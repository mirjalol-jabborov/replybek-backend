/**
 * The small template language integration tools are configured with.
 *
 *   "{{args.order_id}}"            the value itself (keeps numbers, arrays, objects)
 *   "Order {{args.order_id}}"      text with values filled in
 *   "{{now | date:DD.MM.YYYY}}"    filters: date:<format>, default:<value>, number, string
 *   { "$each": "{{args.items}}", "as": "item", "do": { "id": "{{item.product_id}}" } }   a list
 *
 * Paths read from the scope: args (what the AI passed), context (values saved at sign-in),
 * item (inside $each) and now. Missing values become null, never "undefined".
 */

/** Reads "a.b[0].c" from a value. */
export function pick(value, path) {
  if (!path) return value;
  let cur = value;
  for (const part of String(path).match(/[^.[\]]+/g) || []) {
    if (cur == null || ["__proto__", "constructor", "prototype"].includes(part)) return undefined;
    cur = cur[/^\d+$/.test(part) ? Number(part) : part];
  }
  return cur;
}

const pad = (n) => String(n).padStart(2, "0");
function toDate(v) {
  if (v === "now" || v === undefined) return new Date();
  if (v instanceof Date) return v;
  const m = String(v).match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?$/); // DD.MM.YYYY [HH:mm]
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0));
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function formatDate(v, format) {
  const d = toDate(v);
  if (!d) return null;
  return format
    .replace("YYYY", d.getFullYear())
    .replace("MM", pad(d.getMonth() + 1))
    .replace("DD", pad(d.getDate()))
    .replace("HH", pad(d.getHours()))
    .replace("mm", pad(d.getMinutes()));
}

function evaluate(expr, scope) {
  const [path, ...filters] = expr.split("|").map((s) => s.trim());
  let value = path === "now" ? new Date() : pick(scope, path);
  for (const f of filters) {
    const [name, ...rest] = f.split(":");
    const arg = rest.join(":").trim();
    if (name === "default") value = value == null || value === "" ? arg : value;
    else if (name === "date") value = value == null ? null : formatDate(value, arg || "DD.MM.YYYY");
    else if (name === "url") value = value == null ? "" : encodeURIComponent(String(value));
    else if (name === "number") value = value == null || value === "" ? null : Number(value);
    else if (name === "string") value = value == null ? "" : String(value);
  }
  return value;
}

const WHOLE = /^\{\{([^{}]+)\}\}$/;
const PART = /\{\{([^{}]+)\}\}/g;

export function render(template, scope) {
  if (typeof template === "string") {
    const whole = template.match(WHOLE);
    if (whole) {
      const v = evaluate(whole[1], scope);
      return v === undefined ? null : v instanceof Date ? v.toISOString() : v;
    }
    return template.replace(PART, (_, expr) => {
      const v = evaluate(expr, scope);
      return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(template)) return template.map((t) => render(t, scope));
  if (template && typeof template === "object") {
    if ("$each" in template) {
      const list = render(template.$each, scope);
      const as = template.as || "item";
      return (Array.isArray(list) ? list : []).map((item) => render(template.do, { ...scope, [as]: item }));
    }
    return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, render(v, scope)]));
  }
  return template;
}
