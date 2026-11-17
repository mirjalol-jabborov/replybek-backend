// The CRM's refusals. Every one carries a `code`: the app speaks from the codes, `message` is for
// logs and API callers.
import { HttpError } from "../lib/http.js";

/** 400: what was sent doesn't fit. */
export const bad = (message, code, extra) => new HttpError(400, message, { code, ...extra });

/** 409: it can't be done while the rows are as they are now. */
export const conflict = (message, code, extra) => new HttpError(409, message, { code, ...extra });

/**
 * A rule said no: 422 { code: "rules", hard: [reason], soft: [reason], override? }. Reasons are
 * codes with their numbers (see ./shared). `override`, when the area has one, says whether
 * `force` could pass the soft reasons.
 */
export function refusal(hard, soft = [], { message, override } = {}) {
  const text = message || (hard.length ? "This can't be done as it stands." : "This is outside the rules the business set.");
  return new HttpError(422, text, { code: "rules", hard, soft, ...(override === undefined ? {} : { override }) });
}
