// Days and times as the business writes them: a day "2026-11-17", a moment "2026-11-17T09:30",
// a time of day "09:30". Plain strings on the business's own wall clock, so nothing here knows
// about time zones, and nothing reads the clock: "now" is always handed in.

const pad = (n) => String(n).padStart(2, "0");
const utc = (day) => {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

export const dayOf = (iso) => iso.slice(0, 10);
export const hmOf = (iso) => iso.slice(11, 16);
export const at = (day, hm) => `${day}T${hm}`;
export const toMin = (hm) => {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
};
/** 570 → "09:30"; 1440 → "24:00" (the end of a day). */
export const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
export const addDays = (day, n) => {
  const d = utc(day);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
};
/** 0 = Sunday … 6 = Saturday, as in working hours. */
export const weekday = (day) => utc(day).getUTCDay();
/** Monday of the week `day` is in. */
export const weekStart = (day) => addDays(day, -((weekday(day) + 6) % 7));
/** Whole days from one day to another (negative when `to` is earlier). */
export const daysBetween = (from, to) => Math.round((utc(to) - utc(from)) / 86400000);
/** Minutes since 1970 for a local "2026-11-17T09:30", so spans across days compare simply. */
export const absMin = (iso) => Math.round(utc(iso) / 60000) + toMin(iso.slice(11, 16) || "00:00");
/** The moment `min` minutes after (or before) another: addMinutes("2026-11-17T23:30", 45) → "2026-11-18T00:15". */
export function addMinutes(iso, min) {
  const total = toMin(hmOf(iso) || "00:00") + min;
  const days = Math.floor(total / 1440);
  return at(addDays(dayOf(iso), days), fromMin(total - days * 1440));
}

const MOMENT = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;
/** A real moment written "2026-11-17T09:30". */
export const isMoment = (v) => typeof v === "string" && MOMENT.test(v) && ymd(utc(v)) === v.slice(0, 10);

/**
 * The wall clock of a time zone at an instant, as a moment: nowIn("Asia/Tashkent", new Date()).
 * The one place a Date comes in: the caller reads the clock, the rules never do.
 */
export function nowIn(timezone, date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
