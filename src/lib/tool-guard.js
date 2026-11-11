// Checks on what the model sends to, and gets back from, a business's tools.

// Inputs that name a record: an order number, a phone, an account. Asked "where is my order?",
// the model sometimes invents one (order 123456), which could show another customer's data.
const ID_KEY = /(^|[_-])(id|ids|no|num|number|phone|tel|mobile|code|sku|account|invoice|tracking|contract|card)$|[a-z](Id|Ids|Number|Phone|Code)$/;

// Every number written in the text, as digits only ("+998 90 123-45-67" → "998901234567").
const numbersIn = (text) => (String(text || "").match(/\+?\d[\d\s().-]*\d|\d/g) || []).map((n) => n.replace(/\D/g, ""));

/**
 * Names of identifier inputs (at any depth) whose value appears nowhere in `seen`: the
 * customer's messages, earlier replies and tool results. A phone given without the country
 * code still counts ("90 123 45 67" covers 998901234567).
 */
export function inventedIds(args, seen) {
  const known = numbersIn(seen);
  const invented = new Set();
  const visit = (value, key) => {
    if (Array.isArray(value)) return value.forEach((v) => visit(v, key));
    if (value && typeof value === "object") return Object.entries(value).forEach(([k, v]) => visit(v, k));
    if (value == null || !ID_KEY.test(key)) return;
    const digits = String(value).replace(/\D/g, "");
    if (digits.length < 3) return;
    if (!known.some((n) => n.includes(digits) || (n.length >= 7 && digits.includes(n)))) invented.add(key);
  };
  visit(args, "");
  return [...invented];
}

const EMPTY_NOTE = "Nothing matched. Try once more with other words (fewer words, or another language) before telling the customer it isn't there.";

/** An empty lookup result, with a nudge to search again before giving up. */
export function withEmptyHint(output) {
  const empty = Array.isArray(output) ? !output.length : Array.isArray(output?.rows) && !output.rows.length;
  return empty ? { result: output, note: EMPTY_NOTE } : output;
}
