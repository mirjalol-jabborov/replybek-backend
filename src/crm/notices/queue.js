// Turning what a write changed into messages. The host calls onChanges after every CRM write has
// committed (afterWrite in ../modules.js); Booking and Store never call this area.
//
// Each item's last known state is kept in crm_notice_items with the `rev` of the write that showed
// it, and compared with the rows a write reports. Reports can arrive out of order (two writes in
// one workspace commit one after another, but their reports run side by side), so a report older
// than what is kept is passed over, and the reports of one workspace run one at a time.
//
// The channels (Telegram, later SMS) are asked who they reach before the report's transaction:
// they may read the database or the network, and a report that held its connection and its lock
// while a channel waited for another connection could stall every write of the process.
import { query, tx } from "../../core/db.js";
import { reach } from "../../core/senders.js";
import { asQ } from "../db.js";
import { findCustomers } from "../core/customers.js";
import { withDefaults } from "../defaults.js";
import { modules } from "../modules.js";
import { stageOf } from "../shared/lists.js";
import { dayOf, hmOf } from "../shared/time.js";
import { noticeSettings, noticeLanguage, render, dayText, moneyText, nameIn } from "../shared/notices.js";
import { stateOf, bookingNotice, formerNotice, wantsReminder, orderNotice, onePerCustomer } from "./decide.js";
import { wake } from "./send.js";

const ITEMS = ["appointments", "orders"];
const json = (v) => JSON.stringify(v);

/** The team and the services, for the names in a booking's message. Asked through the modules that own them. */
async function bookingNames(q, cfg) {
  const want = (key) => key === "staff" || key === "services";
  const out = { staff: [], services: [] };
  for (const m of modules) if (m.keys.some(want)) Object.assign(out, await m.snapshot({ q, cfg, want, role: "owner", user: null, workspace: { id: cfg.workspaceId } }));
  return { staff: new Map(out.staff.map((s) => [s.id, s])), services: new Map(out.services.map((s) => [s.id, s])) };
}

/** The placeholders of a message about this item, in this language. */
function valuesOf(key, row, language, { customer, business, data, names }) {
  const common = { name: customer.name, business };
  if (key === "appointments") {
    return {
      ...common,
      day: dayText(dayOf(row.start), language),
      time: hmOf(row.start),
      service: row.serviceIds.map((id) => nameIn(names.services.get(id)?.name, language)).filter(Boolean).join(", "),
      specialist: nameIn(names.staff.get(row.staffId)?.name, language),
    };
  }
  return {
    ...common,
    number: row.number,
    total: moneyText(row.totals?.total, language),
    step: nameIn(stageOf(data.orderStages, row.status).name, language),
    day: dayText(row.delivery?.date, language),
    time: row.delivery?.time || row.delivery?.slot || "",
  };
}

/**
 * What this report means: the messages to queue, the items whose waiting messages are now out of
 * date (`stale`: every item with news, whether or not its message is switched on), the reminders
 * to set or drop, and what to remember.
 */
function decide(changes, kept, data, notices, rev) {
  const quiet = Boolean(changes.top?.apptStages || changes.top?.orderStages);
  const says = [];
  const stale = new Set();
  const remind = [];
  const drop = [];
  const remember = [];
  for (const key of ITEMS) {
    for (const row of changes.set?.[key] || []) {
      const was = kept.get(`${key}:${row.id}`);
      if (was && Number(was.rev) >= rev) continue; // a newer write already reported this item
      const next = stateOf(key, row, data);
      const prev = was?.state || null;
      remember.push({ key, id: row.id, state: next });
      // Rows moved out of a removed step by a settings save: the board changed, not the customer's visit.
      const kind = quiet ? null : key === "appointments" ? bookingNotice(prev, next, { seriesId: row.seriesId }) : orderNotice(prev, next, notices.orderStep.steps);
      // Given to another customer: the one it was taken from hears of the visit as they knew it.
      const former = quiet || key !== "appointments" ? null : formerNotice(prev, next);
      const order = key === "appointments" ? row.start : Number(row.number);
      if (kind || former) stale.add(row.id);
      if (kind && notices[kind].on) says.push({ kind, key, row, state: next, customerId: row.customerId, order });
      if (former && notices[former].on) {
        const was = { ...row, customerId: prev.customerId, start: prev.start, staffId: prev.staffId };
        says.push({ kind: former, key, row: was, state: next, customerId: prev.customerId, order: prev.start });
      }
      if (key !== "appointments") continue;
      if (!wantsReminder(next)) drop.push({ id: row.id, reason: "item_closed" });
      else if (!notices.reminder.on) drop.push({ id: row.id, reason: "switched_off" });
      else remind.push({ row, state: next });
    }
    for (const id of changes.del?.[key] || []) remember.push({ key, id, state: null, gone: true });
  }
  return { says: onePerCustomer(says), stale: [...stale], remind, drop, remember };
}

/**
 * Who of these customers each channel reaches, asked outside any transaction (see the top).
 * Returns { [customerId]: { channel, address, language } }.
 */
async function waysTo(cfg, customerIds) {
  const people = (await findCustomers(query, cfg, customerIds)).map(({ id, name, phone, telegram }) => ({ id, name, phone, telegram }));
  return people.length ? reach(cfg.workspaceId, people) : {};
}

/**
 * The customers a report may write to: those of its rows, and those its bookings were taken from
 * (as the kept state names them). Read before the report's lock, so in a rare race (an older
 * report of the same booking finishing meanwhile) a former customer is missing: their message is
 * then recorded as skipped no_channel.
 */
async function customersOf(workspaceId, changes) {
  const ids = new Set(ITEMS.flatMap((key) => (changes.set?.[key] || []).map((r) => r.customerId)).filter(Boolean));
  const appts = (changes.set?.appointments || []).map((r) => r.id);
  if (appts.length) {
    const { rows } = await query(
      "SELECT DISTINCT state->>'customerId' AS id FROM crm_notice_items WHERE workspace_id = $1 AND item_key = 'appointments' AND item_id = ANY($2::uuid[]) AND state ? 'customerId'",
      [workspaceId, appts]
    );
    for (const r of rows) if (r.id) ids.add(r.id);
  }
  return [...ids];
}

/** Each message's text, language and way to the customer (`ways`: from waysTo). */
async function compose(q, cfg, ws, items, ways) {
  if (!items.length) return [];
  const ids = [...new Set(items.map((x) => x.row.customerId))];
  const byId = new Map((await findCustomers(q, cfg, ids)).map((c) => [c.id, c]));
  const names = items.some((x) => x.key === "appointments") ? await bookingNames(q, cfg) : null;
  return items
    .filter((x) => byId.has(x.row.customerId))
    .map((x) => {
      const way = ways[x.row.customerId];
      const language = noticeLanguage(way?.language, ws.notices.language);
      const values = valuesOf(x.key, x.row, language, { customer: byId.get(x.row.customerId), business: ws.name, data: ws.data, names });
      return {
        kind: x.kind,
        item_key: x.key,
        item_id: x.row.id,
        customer_id: x.row.customerId,
        staff_id: x.key === "appointments" ? x.row.staffId || null : null,
        channel: way?.channel || "none",
        address: way?.address || "",
        text: render(ws.notices[x.kind].text[language], values),
        language,
        item_start: x.key === "appointments" ? x.row.start : null,
        // The item as this message was written for it: checked again before it goes (send.js).
        item_state: x.state,
      };
    });
}

const COLS = "customer_id uuid, kind text, item_key text, item_id uuid, staff_id uuid, channel text, address text, text text, language text, item_start text, item_state jsonb";

/**
 * Queues the messages a committed write calls for, re-times or drops the reminders of the bookings
 * it touched, and wakes the sender when something is due. ctx: { workspaceId, cfg (as the write read it) }.
 */
export async function onChanges({ workspaceId, cfg }, changes) {
  const touches = ITEMS.some((k) => changes.set?.[k]?.length || changes.del?.[k]?.length) || changes.top?.settings;
  if (!touches) return;
  const ways = await waysTo(cfg, await customersOf(workspaceId, changes));
  const due = await tx(async (c) => {
    const q = asQ(c);
    await q("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`crm_notices:${workspaceId}`]);
    const { rows } = await q("SELECT s.data, s.timezone, w.name FROM crm_settings s JOIN workspaces w ON w.id = s.workspace_id WHERE s.workspace_id = $1", [workspaceId]);
    if (!rows[0]) return [];
    const data = withDefaults(rows[0].data);
    const ws = { data, name: rows[0].name, notices: noticeSettings(data.settings) };
    const at = { ...cfg, data, timezone: rows[0].timezone };
    const times = [];

    if (changes.top?.settings) times.push(...(await settingsSaved(q, at, ws)));

    const all = ITEMS.flatMap((key) => [...(changes.set?.[key] || []).map((r) => [key, r.id]), ...(changes.del?.[key] || []).map((id) => [key, id])]);
    if (!all.length) return times;
    const { rows: keptRows } = await q(
      `SELECT i.item_key, i.item_id, i.rev, i.state FROM crm_notice_items i JOIN unnest($2::text[], $3::uuid[]) AS r(k, id) ON i.item_key = r.k AND i.item_id = r.id WHERE i.workspace_id = $1`,
      [workspaceId, all.map((x) => x[0]), all.map((x) => x[1])]
    );
    const kept = new Map(keptRows.map((r) => [`${r.item_key}:${r.item_id}`, r]));
    const { says, stale, remind, drop, remember } = decide(changes, kept, data, ws.notices, cfg.rev);

    // A deleted item takes everything still waiting about it along.
    const gone = remember.filter((r) => r.gone).map((r) => r.id);
    if (gone.length) await q("UPDATE crm_notices SET status = 'skipped', reason = 'item_gone' WHERE workspace_id = $1 AND item_id = ANY($2::uuid[]) AND status = 'queued'", [workspaceId, gone]);
    if (drop.length) {
      await q(
        `UPDATE crm_notices n SET status = 'skipped', reason = r.reason FROM unnest($2::uuid[], $3::text[]) AS r(id, reason)
          WHERE n.workspace_id = $1 AND n.item_id = r.id AND n.kind = 'reminder' AND n.status = 'queued'`,
        [workspaceId, drop.map((d) => d.id), drop.map((d) => d.reason)]
      );
    }

    // News about an item makes what still waits about it out of date, even when the news itself is
    // switched off (a reminder has its own rules, below).
    if (stale.length) {
      await q("UPDATE crm_notices SET status = 'skipped', reason = 'superseded' WHERE workspace_id = $1 AND item_id = ANY($2::uuid[]) AND status = 'queued' AND kind <> 'reminder'", [workspaceId, stale]);
    }
    const composed = await compose(q, at, ws, [...says, ...remind.map((r) => ({ kind: "reminder", key: "appointments", ...r }))], ways);
    const messages = composed.filter((m) => m.kind !== "reminder");
    const reminders = composed.filter((m) => m.kind === "reminder");
    if (messages.length) {
      const { rows: queued } = await q(
        `INSERT INTO crm_notices (workspace_id, customer_id, kind, item_key, item_id, staff_id, channel, address, text, language, status, reason, item_state)
         SELECT $1, r.customer_id, r.kind, r.item_key, r.item_id, r.staff_id, r.channel, r.address, r.text, r.language,
                CASE WHEN r.channel = 'none' THEN 'skipped' ELSE 'queued' END, CASE WHEN r.channel = 'none' THEN 'no_channel' END, r.item_state
           FROM jsonb_to_recordset($2::jsonb) AS r(${COLS})
         RETURNING status, send_at`,
        [workspaceId, json(messages)]
      );
      times.push(...queued.filter((r) => r.status === "queued").map((r) => r.send_at));
    }
    if (reminders.length) times.push(...(await setReminders(q, at, reminders)));

    // What every reported item looks like now; an older report never overwrites a newer one.
    await q(
      `INSERT INTO crm_notice_items (workspace_id, item_key, item_id, rev, state)
       SELECT $1, r.key, r.id, $2, r.state FROM jsonb_to_recordset($3::jsonb) AS r(key text, id uuid, state jsonb)
       ON CONFLICT (workspace_id, item_key, item_id) DO UPDATE SET rev = EXCLUDED.rev, state = EXCLUDED.state WHERE crm_notice_items.rev < EXCLUDED.rev`,
      [workspaceId, cfg.rev, json(remember.map(({ key, id, state }) => ({ key, id, state })))]
    );
    return times;
  });
  if (due.length) await wake(new Date(Math.min(...due.map((t) => new Date(t).getTime()))));
}

/**
 * A booking's reminder: `remindBefore` minutes before its start, on the business's clock turned
 * into a real instant. Set in place when one is waiting (the booking moved), made when not;
 * dropped when that moment has already passed. A reminder waiting for another try after a failed
 * one keeps its time while its visit keeps its start: an edit never cuts its wait short, and its
 * moment having passed is why it is being retried, not a reason to drop it. Returns the send times.
 */
async function setReminders(q, cfg, reminders) {
  const { workspaceId, timezone: tz } = cfg;
  const before = cfg.data.settings.remindBefore;
  const { rows } = await q(
    `INSERT INTO crm_notices (workspace_id, customer_id, kind, item_key, item_id, staff_id, channel, address, text, language, status, send_at, item_at, item_start, item_state)
     SELECT $1, r.customer_id, 'reminder', r.item_key, r.item_id, r.staff_id, r.channel, r.address, r.text, r.language, 'queued',
            (r.item_start::timestamp AT TIME ZONE $2) - make_interval(mins => $3), r.item_start::timestamp AT TIME ZONE $2, r.item_start, r.item_state
       FROM jsonb_to_recordset($4::jsonb) AS r(${COLS})
      WHERE (r.item_start::timestamp AT TIME ZONE $2) - make_interval(mins => $3) > now()
         OR EXISTS (SELECT 1 FROM crm_notices w WHERE w.workspace_id = $1 AND w.item_id = r.item_id AND w.kind = 'reminder' AND w.status = 'queued' AND w.tries > 0 AND w.item_start = r.item_start)
     ON CONFLICT (workspace_id, item_id) WHERE kind = 'reminder' AND status = 'queued'
     DO UPDATE SET customer_id = EXCLUDED.customer_id, staff_id = EXCLUDED.staff_id, channel = EXCLUDED.channel, address = EXCLUDED.address,
                   text = EXCLUDED.text, language = EXCLUDED.language, item_at = EXCLUDED.item_at, item_start = EXCLUDED.item_start, item_state = EXCLUDED.item_state,
                   send_at = CASE WHEN crm_notices.tries > 0 AND crm_notices.item_start = EXCLUDED.item_start THEN crm_notices.send_at ELSE EXCLUDED.send_at END
     RETURNING item_id, send_at`,
    [workspaceId, tz, before, json(reminders)]
  );
  const set = new Set(rows.map((r) => r.item_id));
  const late = reminders.filter((r) => !set.has(r.item_id)).map((r) => r.item_id);
  if (late.length) await q("UPDATE crm_notices SET status = 'skipped', reason = 'too_late' WHERE workspace_id = $1 AND item_id = ANY($2::uuid[]) AND kind = 'reminder' AND status = 'queued'", [workspaceId, late]);
  return rows.map((r) => r.send_at);
}

/**
 * Settings were saved: what waits follows them. A switch turned off drops its waiting messages;
 * a new remindBefore re-times the waiting reminders (their text names the visit, not the gap), by
 * the rule a new booking follows: one whose new moment has passed is dropped (too_late), never
 * sent at once. A reminder waiting for another try keeps its time.
 */
async function settingsSaved(q, cfg, ws) {
  const off = Object.keys(ws.notices).filter((k) => ws.notices[k]?.on === false);
  if (off.length) await q("UPDATE crm_notices SET status = 'skipped', reason = 'switched_off' WHERE workspace_id = $1 AND status = 'queued' AND kind = ANY($2::text[])", [cfg.workspaceId, off]);
  const { rows } = await q(
    `WITH t AS (SELECT id, item_at - make_interval(mins => $2) AS at FROM crm_notices
                 WHERE workspace_id = $1 AND kind = 'reminder' AND status = 'queued' AND tries = 0 AND send_at <> item_at - make_interval(mins => $2))
     UPDATE crm_notices n SET send_at = CASE WHEN t.at > now() THEN t.at ELSE n.send_at END,
                              status = CASE WHEN t.at > now() THEN 'queued' ELSE 'skipped' END,
                              reason = CASE WHEN t.at > now() THEN n.reason ELSE 'too_late' END
       FROM t WHERE n.workspace_id = $1 AND n.id = t.id
     RETURNING n.status, n.send_at`,
    [cfg.workspaceId, cfg.data.settings.remindBefore]
  );
  return rows.filter((r) => r.status === "queued").map((r) => r.send_at);
}
