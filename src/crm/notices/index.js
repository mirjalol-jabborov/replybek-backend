// Messages from the CRM to a customer: a booking confirmed, moved or cancelled, a reminder before
// it, an order entering a step the business ticked, an order cancelled. Every one is optional, with
// its own switch and its own text in settings.notices (see settings.js).
// What a module exports is described in ../modules.js. This area hears about bookings and orders
// only through onChanges, after the host's writes; the jobs worker sends (send.js).
import { listNotices } from "./notices.js";
import "./send.js"; // registers the job that sends what is due

export { router } from "./routes.js";
export { settingsShape } from "./settings.js";
export { onChanges } from "./queue.js";
export const keys = ["notices"];

/** The last 100 messages, newest first. */
export async function snapshot(ctx) {
  return ctx.want("notices") ? { notices: (await listNotices(ctx, { limit: 100 })).notices } : {};
}
