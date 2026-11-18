// Exports: the workspace's customers, products (each variant with its stock), and the bookings and
// orders of a span of days, as .xlsx files in one language. Read on one unchanging picture.
import { z } from "zod";
import { day, uuid, daySpan } from "../shapes.js";
import { addDays } from "../shared/time.js";
import { read } from "../db.js";
import { narrowTo } from "../branches/access.js";
import { writeBook } from "./xlsx.js";
import { LANGUAGES, sheetName } from "../shared/sheets.js";
import { customersSheet } from "./customers.js";
import { productsSheet } from "./products.js";
import { bookingsSheet } from "./bookings.js";
import { ordersSheets } from "./orders.js";

const lang = z.enum(LANGUAGES).optional();
export const exportSchema = z.object({ lang }).strict();
/** Bookings and orders: a span as a report's, at most two years (shared/period.js). */
export const spanSchema = z.object({ from: day, to: day, branch: uuid.optional(), lang }).strict().refine(...daySpan);

export const EXPORTS = ["customers", "products", "bookings", "orders"];

/** The file for `what`: { file: "orders-2026-11-01-2026-11-30.xlsx", data }. `language`: en | ru | uz. */
export function exportBook(workspaceId, what, input, language) {
  return read(workspaceId, async (q, cfg) => {
    let sheets;
    if (what === "customers") sheets = [{ name: sheetName("customers", language), ...(await customersSheet(q, cfg, language)) }];
    else if (what === "products") sheets = [{ name: sheetName("products", language), ...(await productsSheet(q, cfg, language)) }];
    else {
      const p = { from: input.from, end: addDays(input.to, 1), branch: await narrowTo(q, cfg, input.branch, null) };
      if (what === "bookings") sheets = [{ name: sheetName("bookings", language), ...(await bookingsSheet(q, cfg, p, language)) }];
      else {
        const [orders, lines] = await ordersSheets(q, cfg, p, language);
        sheets = [{ name: sheetName("orders", language), ...orders }, { name: sheetName("lines", language), ...lines }];
      }
    }
    const span = input.from ? `${input.from}-${input.to}` : cfg.now.slice(0, 10);
    return { file: `${what}-${span}.xlsx`, data: writeBook(sheets) };
  });
}
