// Reports: read-only numbers about bookings, orders, stock and customers for a span of days.
// A module of the host (see ../modules.js) with routes only: it owns no snapshot keys and writes
// nothing. It reads the Booking and Store tables in SQL (each report is one query that adds up in
// the database), and imports no code of theirs.
export { router } from "./routes.js";
export const keys = [];
export async function snapshot() {
  return {};
}
