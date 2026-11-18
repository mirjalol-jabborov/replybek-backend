// The CRM's refusals. Every one carries a `code`: the app speaks from the codes, `message` is for
// logs and API callers.
import { HttpError } from "../core/http.js";
import { forCustomer, PER_PHONE_PER_DAY } from "./shared/customer.js";

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

/** 429: this customer made the day's share of bookings, or of orders, themselves already. */
export const shareUsed = () => new HttpError(429, "This phone made today's bookings or orders already.", { code: "phone_limit", max: PER_PHONE_PER_DAY });

/**
 * Runs a module's write for `who`. A customer acting for themselves (`who.by === "customer"`: a
 * public page, the AI agent) gets a rule refusal with only what they may see of each reason
 * (forCustomer) and nothing about forcing; the team gets it whole.
 */
export async function refusalsFor(who, run) {
  try {
    return await run();
  } catch (e) {
    if (who?.by !== "customer" || !(e instanceof HttpError) || e.extra?.code !== "rules") throw e;
    throw refusal((e.extra.hard || []).map(forCustomer), (e.extra.soft || []).map(forCustomer), { message: e.message });
  }
}
