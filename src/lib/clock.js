/** A time zone the runtime knows ("Asia/Tashkent"), or null for anything else. */
export function validTimeZone(tz) {
  if (typeof tz !== "string" || !tz.trim()) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() });
    return tz.trim();
  } catch {
    return null;
  }
}

/** The local date and time in a time zone: "Tuesday 2026-11-11, 19:32 (Asia/Tashkent, GMT+5)". */
export function describeNow(timeZone, now = new Date()) {
  const tz = validTimeZone(timeZone) || "UTC";
  const part = (options) => new Intl.DateTimeFormat("en-US", { timeZone: tz, ...options }).format(now);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value;
  return `${part({ weekday: "long" })} ${date}, ${part({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} (${tz}${offset ? `, ${offset}` : ""})`;
}
