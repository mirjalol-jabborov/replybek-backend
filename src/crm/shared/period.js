// The span of days a report or an export of bookings and orders covers: `from` and `to` on the
// business's clock, both included. The app checks a chosen span with the same rule before asking.
import { daysBetween } from "./time.js";

/** The longest span, in days: two years. */
export const MAX_DAYS = 731;

/** Whether a span is one the server takes: from <= to, at most MAX_DAYS days. */
export const fitsSpan = ({ from, to }) => from <= to && daysBetween(from, to) < MAX_DAYS;
