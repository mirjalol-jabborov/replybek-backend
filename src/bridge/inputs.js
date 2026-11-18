// The shapes the CRM tools take from the model, in one place: ids, days and moments. The patterns
// go to the model with the tool; realDates() then turns away a day the calendar doesn't have
// (2027-02-31), which no pattern can, before any rule or query sees it.
import { isMoment } from "../crm/shared/time.js";

export const id = { type: "string", pattern: "^[0-9a-fA-F-]{36}$" };
const DAY = "\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])";
export const day = { type: "string", pattern: `^${DAY}$`, description: "YYYY-MM-DD, on the business's calendar." };
export const moment = { type: "string", pattern: `^${DAY}T([01]\\d|2[0-3]):[0-5]\\d$`, description: "YYYY-MM-DDTHH:MM, exactly as a free time came back." };

// The inputs that hold a day or a moment, wherever they sit in a tool's input.
const DATED = new Set(["day", "start"]);

/** The paths of days and moments in a tool's input that are not real ones: [] when all are. */
export function unrealDates(v, at = "") {
  if (!v || typeof v !== "object") return [];
  return Object.entries(v).flatMap(([k, x]) => {
    if (DATED.has(k) && typeof x === "string") return isMoment(x.length === 10 ? `${x}T00:00` : x) ? [] : [`${at}/${k} not_a_date`];
    return unrealDates(x, `${at}/${k}`);
  });
}
