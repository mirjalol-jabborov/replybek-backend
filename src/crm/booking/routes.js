// The Booking module's routes, mounted at /w/:wid/crm. A route only parses, checks the role and
// calls; the business steps live in the entity files.
//
// Who may do what: a team member works with bookings and blocks time; setting up the team and
// the services, and deleting a booking, is for admins and the owner. A team member linked to a
// specialist with ownOnly sees and changes only their own bookings (checked in the entity files).
import { Router } from "express";
import { wrap } from "../../core/http.js";
import { validate } from "../../core/validate.js";
import { requireRole } from "../../core/workspaces/access.js";
import * as staff from "./staff.js";
import * as services from "./services.js";
import * as off from "./time-off.js";
import * as appts from "./appointments.js";
import * as steps from "./steps.js";
import * as series from "./series.js";
import * as free from "./free-times.js";

export const router = Router({ mergeParams: true });
const admin = requireRole("admin");
const who = (req) => ({ user: req.user, role: req.role });
const wid = (req) => req.workspace.id;
/** A route that answers with what the entity file returns. */
const route = (fn, status = 200) => wrap(async (req, res) => res.status(status).json(await fn(req)));

router.post("/staff", admin, validate(staff.staffCreateSchema), route((req) => staff.createStaff(wid(req), req.valid), 201));
router.put("/staff/:id", admin, validate(staff.staffUpdateSchema), route((req) => staff.updateStaff(wid(req), req.params.id, req.valid)));
router.delete("/staff/:id", admin, route((req) => staff.deleteStaff(wid(req), req.params.id)));

router.post("/services", admin, validate(services.serviceCreateSchema), route((req) => services.createService(wid(req), req.valid), 201));
router.put("/services/:id", admin, validate(services.serviceUpdateSchema), route((req) => services.updateService(wid(req), req.params.id, req.valid)));
router.delete("/services/:id", admin, route((req) => services.deleteService(wid(req), req.params.id)));

router.post("/time-off", validate(off.timeOffCreateSchema), route((req) => off.createTimeOff(wid(req), who(req), req.valid), 201));
router.put("/time-off/:id", validate(off.timeOffUpdateSchema), route((req) => off.updateTimeOff(wid(req), who(req), req.params.id, req.valid)));
router.delete("/time-off/:id", route((req) => off.deleteTimeOff(wid(req), who(req), req.params.id)));

router.post("/appointments", validate(appts.createSchema), route((req) => appts.bookAppointment(wid(req), who(req), req.valid), 201));
router.put("/appointments/:id", validate(appts.editSchema), route((req) => appts.editAppointment(wid(req), who(req), req.params.id, req.valid)));
// Dragging on the calendar: an edit of just the time and the specialist.
router.post("/appointments/:id/move", validate(appts.moveSchema), route((req) => appts.editAppointment(wid(req), who(req), req.params.id, req.valid)));
router.post("/appointments/:id/step", validate(steps.stepSchema), route((req) => steps.stepAppointment(wid(req), who(req), req.params.id, req.valid)));
router.post("/appointments/:id/pay", validate(appts.paySchema), route((req) => appts.payAppointment(wid(req), who(req), req.params.id, req.valid)));
router.delete("/appointments/:id", admin, route((req) => appts.deleteAppointment(wid(req), req.params.id)));

router.post("/series", validate(series.seriesCreateSchema), route((req) => series.createSeries(wid(req), who(req), req.valid), 201));
router.put("/series/:id", validate(series.seriesChangeSchema), route((req) => series.changeSeries(wid(req), who(req), req.params.id, req.valid)));
router.post("/series/:id/stop", validate(series.seriesStopSchema), route((req) => series.stopSeries(wid(req), who(req), req.params.id, req.valid)));

router.post("/booking/check", validate(free.checkSchema), route((req) => free.checkDraft(wid(req), who(req), req.valid)));
router.get("/booking/slots", validate(free.slotsSchema, "query"), route((req) => free.slots(wid(req), who(req), req.valid)));
