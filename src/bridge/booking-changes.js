// Changes to the customer's bookings through the AI agent: book, move, cancel. Each has a plan,
// which checks the rules and words the card, and an apply, which runs when the customer presses
// Confirm: the Booking module's own write for a customer acting for themselves (asCustomer), so
// its rules are asked again inside the write that makes the change. A time taken meanwhile is
// refused (with the times free now), and so is a price or length other than the card showed.
// A customer may change a booking only until rules.cancelUntil before it (shared cancelProblem,
// the rule the public pages and the module use), and makes at most their daily share (capReached).
import { read, write } from "../crm/db.js";
import { HttpError } from "../core/http.js";
import { refusal } from "../crm/errors.js";
import { mergeChanges } from "../crm/changes.js";
import { bookAppointment, editAppointment, cancelAppointment, getAppointment, loadRules } from "../crm/booking/index.js";
import { totals, cancelProblem } from "../crm/shared/booking.js";
import { forCustomer } from "../crm/shared/customer.js";
import { cleanFields, customerFields } from "../crm/shared/fields.js";
import { dayOf } from "../crm/shared/time.js";
import { asCustomer, ensureCustomer, rememberItem, mineTest, capReached, capAnswer } from "./customer.js";
import { teamAndServices, servicesProblem, judge, offer, refused, serviceNames, staffName, freeTimes } from "./booking-times.js";
import { word, whenText, moneyText, nameIn } from "./wording.js";

/** The customer's own booking that they may still change themselves, or a refusal { error, handoff? }. */
async function own(q, cfg, access, link, id) {
  const a = await getAppointment(q, cfg, id).catch(() => null);
  if (!(await mineTest(q, access, link, "appointment"))(a)) return { error: "not_found" };
  const problem = cancelProblem(cfg.data.apptStages, a, cfg.data.settings.rules, cfg.now);
  if (!problem) return { a };
  const { code, ...params } = forCustomer(problem);
  return { error: code, ...params, handoff: true };
}
/**
 * own()'s refusal on Confirm, as the same answer the tool gives before a card ({ error, minutes?,
 * handoff? }): about the booking, not the time, so the agent offers the team and no other times.
 */
const failed = ({ error, ...params }) => new HttpError(422, "This booking can't be changed by the customer now.", { code: error, ...params });

/**
 * The booking fields the customer gave, as card lines: only the ones a customer fills (the
 * module keeps only those too). A value that doesn't fit its field is { error: "bad_fields" }.
 */
function fieldLines(cfg, lang, sent = {}) {
  const defs = customerFields(cfg.data.fields.appointment);
  const { values, errors } = cleanFields(defs, sent, {});
  if (Object.keys(errors).length) return { error: "bad_fields", fields: Object.keys(errors) };
  return { lines: defs.filter((f) => values[f.id] !== undefined && values[f.id] !== "").map((f) => [nameIn(lang, f.name), String(values[f.id])]) };
}

export const book = {
  async plan(access, link, args, lang) {
    return read(access.workspace.id, async (q, cfg) => {
      const db = await loadRules(q, cfg, dayOf(args.start), dayOf(args.start));
      const problem = servicesProblem(db, args.services);
      if (problem) return problem;
      const given = fieldLines(cfg, lang, args.fields);
      if (given.error) return given;
      if (await capReached(q, cfg, link, "appointment")) return capAnswer();
      const sum = totals(db, args.services);
      const draft = { staffId: args.specialist || null, serviceIds: args.services, start: args.start, duration: sum.duration };
      const j = judge(db, draft, cfg.now);
      if (!j.ok) return refused(db, draft, j.result, cfg.now);
      return {
        // The price and length the card shows: Confirm books these or nothing.
        args: { services: args.services, start: args.start, specialist: args.specialist || null, note: args.note || "", fields: args.fields || {}, price: sum.price, duration: sum.duration },
        summary: {
          title: word(lang, "book"),
          lines: [[word(lang, "service"), serviceNames(lang, db, args.services)], [word(lang, "when"), whenText(lang, args.start)], [word(lang, "specialist"), args.specialist ? staffName(db, args.specialist) : word(lang, "anyone")], ...given.lines],
          total: `${word(lang, "total")}: ${moneyText(lang, sum.price)}`,
        },
      };
    });
  },
  apply(access, link, args) {
    return write(access.workspace.id, async (c, cfg, q) => {
      const customer = await ensureCustomer(c, cfg, access, link);
      const made = await bookAppointment({ c, cfg }, asCustomer(link), { customerId: customer.id, serviceIds: args.services, staffId: args.specialist, start: args.start, note: args.note, fields: args.fields });
      const [row] = made.changes.set.appointments;
      // Booked at what the services cost now: anything but what the card showed undoes it all.
      if (row.price !== args.price || row.duration !== args.duration) throw refusal([{ code: "price_changed" }]);
      await rememberItem(q, access, "appointment", row.id);
      return { changes: mergeChanges(made.changes, customer.added && { set: { customers: [customer.added] } }), result: { booking: row.id, start: row.start, specialist: staffName(await teamAndServices(q, cfg), row.staffId) } };
    });
  },
  // After a refusal on Confirm: the times the agent can offer now.
  alternatives(access, args) {
    return freeTimes(access, { services: args.services, specialist: args.specialist, day: dayOf(args.start) });
  },
};

export const cancel = {
  async plan(access, link, args, lang) {
    return read(access.workspace.id, async (q, cfg) => {
      const mine = await own(q, cfg, access, link, args.booking);
      if (mine.error) return mine;
      const db = await teamAndServices(q, cfg);
      return {
        args: { booking: args.booking },
        summary: {
          title: word(lang, "cancel"),
          lines: [[word(lang, "service"), serviceNames(lang, db, mine.a.serviceIds)], [word(lang, "when"), whenText(lang, mine.a.start)], [word(lang, "specialist"), staffName(db, mine.a.staffId)]],
          total: null,
        },
      };
    });
  },
  apply(access, link, args) {
    return write(access.workspace.id, async (c, cfg, q) => {
      // Asked again inside the write, under its lock: the module's own rule, so it has the same answer.
      const mine = await own(q, cfg, access, link, args.booking);
      if (mine.error) throw failed(mine);
      const { changes } = await cancelAppointment({ c, cfg }, asCustomer(link), args.booking);
      return { changes, result: { booking: args.booking, cancelled: true } };
    });
  },
};

/** The visit at its new time: the same services and length, the same specialist unless another (or "any") is named. */
const moved = (a, args) => ({ staffId: args.specialist === "any" ? null : args.specialist || a.staffId, serviceIds: a.serviceIds, start: args.start, duration: a.duration, ignoreId: a.id });

export const move = {
  async plan(access, link, args, lang) {
    return read(access.workspace.id, async (q, cfg) => {
      const mine = await own(q, cfg, access, link, args.booking);
      if (mine.error) return mine;
      const db = await loadRules(q, cfg, dayOf(args.start), dayOf(args.start));
      const draft = moved(mine.a, args);
      const j = judge(db, draft, cfg.now);
      if (!j.ok) return refused(db, draft, j.result, cfg.now);
      return {
        args: { booking: args.booking, start: args.start, specialist: args.specialist || null },
        summary: {
          title: word(lang, "move"),
          lines: [
            [word(lang, "service"), serviceNames(lang, db, mine.a.serviceIds)],
            [word(lang, "was"), whenText(lang, mine.a.start)],
            [word(lang, "when"), whenText(lang, args.start)],
            [word(lang, "specialist"), draft.staffId ? staffName(db, draft.staffId) : word(lang, "anyone")],
          ],
          total: null,
        },
      };
    });
  },
  apply(access, link, args) {
    return write(access.workspace.id, async (c, cfg, q) => {
      const mine = await own(q, cfg, access, link, args.booking);
      if (mine.error) throw failed(mine);
      const staff = args.specialist === "any" ? { staffId: null } : args.specialist ? { staffId: args.specialist } : {};
      const { changes } = await editAppointment({ c, cfg }, asCustomer(link), args.booking, { start: args.start, ...staff });
      const row = changes.set?.appointments?.[0] || mine.a;
      return { changes, result: { booking: row.id, start: row.start, specialist: staffName(await teamAndServices(q, cfg), row.staffId) } };
    });
  },
  alternatives(access, args) {
    return read(access.workspace.id, async (q, cfg) => {
      const a = await getAppointment(q, cfg, args.booking).catch(() => null);
      if (!a) return {};
      const db = await loadRules(q, cfg, dayOf(args.start), dayOf(args.start));
      return offer(db, moved(a, args), cfg.now);
    });
  },
};
