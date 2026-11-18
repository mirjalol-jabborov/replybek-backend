// Whether the business is open right now, for the top of its public page: "Open until 21:00" or
// "Closed, opens at 09:00". Worked out on the server, on the business's own clock (cfg.now, read
// in the workspace's time zone), from the hours the CRM already keeps:
//   - the default branch's own working hours, when it sets them ({ "0".."6": ["09:00", "18:00"] | null });
//   - else the business day of the settings (dayStart to dayEnd), every day;
//   - less the days and hours the whole business is closed (time off with no specialist, for the
//     default branch or for every branch).
import { query } from "../../core/db.js";
import { offOn } from "../shared/booking.js";
import { addDays, dayOf, fromMin, toMin, weekday } from "../shared/time.js";

/** How many days ahead the next opening is looked for. Past that, the page says nothing about it. */
export const LOOK_AHEAD = 14;

/** The minutes [from, to) the business works on a day, as a list (a closing in the middle splits it). */
function openSpans(day, { dayStart, dayEnd, branch, timeOff }) {
  if (branch && branch.active === false) return [];
  const h = branch?.hours ? branch.hours[weekday(day)] : [dayStart, dayEnd];
  if (!h) return [];
  let spans = [[toMin(h[0]), toMin(h[1])]];
  for (const off of offOn({ timeOff }, null, day, branch?.id || null)) {
    spans = spans.flatMap(([a, b]) => [
      [a, Math.min(b, off.from)],
      [Math.max(a, off.to), b],
    ]).filter(([a, b]) => a < b);
  }
  return spans;
}

/**
 * { open: true, until: "21:00" | null (around the clock), opens: null } while it is open now; else { open: false, until: null,
 * opens: { date, time } | null } (the next opening within LOOK_AHEAD days). `now`: "2026-11-18T09:30"
 * on the business's clock. Pure: the rows come in `hours` ({ dayStart, dayEnd, branch, timeOff }).
 */
export function openingOf(now, hours) {
  const today = dayOf(now);
  const nowMin = toMin(now.slice(11, 16));
  const spansOf = (day) => openSpans(day, hours);
  const current = spansOf(today).find(([a, b]) => a <= nowMin && nowMin < b);
  if (current) {
    // Open past midnight: it stays open until the next day's first span ends, when that starts at
    // 00:00. Open all of today and tomorrow: around the clock, `until` null.
    let until = current[1];
    if (until === 1440) {
      const next = spansOf(addDays(today, 1)).find(([a]) => a === 0);
      if (next) until = next[1] === 1440 ? null : next[1];
    }
    return { open: true, until: until === null ? null : fromMin(until % 1440), opens: null };
  }
  for (let i = 0; i <= LOOK_AHEAD; i++) {
    const day = addDays(today, i);
    const next = spansOf(day).find(([a]) => i > 0 || a > nowMin);
    if (next) return { open: false, until: null, opens: { date: day, time: fromMin(next[0]) } };
  }
  return { open: false, until: null, opens: null };
}

const moment = (col) => `to_char(${col}, 'YYYY-MM-DD"T"HH24:MI')`;

/** The rows openingOf needs, read for this workspace: its default branch and the business's closings ahead. */
export async function hoursOf(q = query, cfg) {
  const today = dayOf(cfg.now);
  const rows = async (text, params) => (await q(text, params)).rows;
  const [branch] = await rows("SELECT id, hours, active FROM crm_branches WHERE workspace_id = $1 AND is_default", [cfg.workspaceId]);
  const timeOff = await rows(
    `SELECT staff_id AS "staffId", branch_id AS "branchId", ${moment("start_at")} AS start, ${moment("end_at")} AS "end"
       FROM crm_time_off WHERE workspace_id = $1 AND staff_id IS NULL AND end_at >= $2::date AND start_at < $3::date`,
    [cfg.workspaceId, today, addDays(today, LOOK_AHEAD + 2)]
  );
  const { dayStart, dayEnd } = cfg.data.settings;
  return { dayStart, dayEnd, branch: branch || null, timeOff };
}
