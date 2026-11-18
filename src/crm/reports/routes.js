// The reports' routes, mounted at /w/:wid/crm. Admins and the owner only. Each takes the query
// `from`, `to` (days, both included) and an optional `branch`; income also takes `by`.
// What each number means is in the file that works it out.
import { Router } from "express";
import { wrap } from "../../core/http.js";
import { validate } from "../../core/validate.js";
import { requireRole } from "../../core/workspaces/access.js";
import { periodSchema, incomeSchema } from "./period.js";
import { incomeReport } from "./income.js";
import { bookingsReport } from "./bookings.js";
import { servicesReport } from "./services.js";
import { specialistsReport } from "./specialists.js";
import { productsReport } from "./products.js";
import { stockReport } from "./stock.js";
import { customersReport } from "./customers.js";

export const router = Router({ mergeParams: true });
const admin = requireRole("admin");
const report = (path, schema, run) => router.get(`/reports/${path}`, admin, validate(schema, "query"), wrap(async (req, res) => res.json(await run(req.workspace.id, req.valid))));

report("income", incomeSchema, incomeReport);
report("bookings", periodSchema, bookingsReport);
report("services", periodSchema, servicesReport);
report("specialists", periodSchema, specialistsReport);
report("products", periodSchema, productsReport);
report("stock", periodSchema, stockReport);
report("customers", periodSchema, customersReport);
