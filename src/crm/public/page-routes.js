// The public API behind a business's own booking page and shop page, mounted at
// /public/crm/:slug by src/app.js. No session cookie, ever. Anyone may read it from any site;
// writes come only from the app's own addresses (where the pages are served) and as JSON.
// A route only checks the input and calls; the work is in booking.js and shop.js.
import express, { Router } from "express";
import cors from "cors";
import { HttpError, wrap } from "../../core/http.js";
import { validate } from "../../core/validate.js";
import { rateLimit, clientIP } from "../../core/rate-limit.js";
import { appOrigins } from "../../core/auth/session.js";
import { SLUG } from "./rules.js";
import { showFront, workspaceOfPage, checkPart, pageNotFound } from "./pages.js";
import { decoy } from "./requests.js";
import { slotsQuery, daysQuery, lookupQuery, tokenBody, bookingBody, orderBody } from "./checks.js";
import { listServices, listSlots, listDays, bookVisit, showBooking, cancelVisit } from "./booking.js";
import { listCatalogue, listCategories, sendPicture, placeOrder, showOrder } from "./shop.js";

export const router = Router({ mergeParams: true });

const READS = ["GET", "HEAD"];
router.use(cors((req, done) => done(null, { origin: READS.includes(req.method) ? true : appOrigins(), credentials: false })));
router.use(express.json({ limit: "16kb" }));
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (!READS.includes(req.method) && req.method !== "OPTIONS" && !String(req.headers["content-type"] || "").startsWith("application/json")) {
    return next(new HttpError(415, "Send JSON.", { code: "send_json" }));
  }
  next();
});

// Limits: per address of the caller, and per page, so neither one visitor nor a crowd can flood a business.
const slugOf = (req) => (SLUG.test(req.params.slug || "") ? req.params.slug : null);
const code = "rate_limited";
const limits = {
  readsPerIP: rateLimit({ windowMs: 60 * 1000, max: 120, key: clientIP, code }),
  readsPerPage: rateLimit({ windowMs: 60 * 1000, max: 1200, key: slugOf, code }),
  writesPerIP: rateLimit({ windowMs: 10 * 60 * 1000, max: 10, key: clientIP, message: "Too many tries from this network. Try again later.", code }),
  writesPerPage: rateLimit({ windowMs: 10 * 60 * 1000, max: 100, key: slugOf, message: "Too many tries. Try again later.", code }),
};
router.use((req, res, next) => (READS.includes(req.method) ? limits.readsPerIP : limits.writesPerIP)(req, res, next));
router.use((req, res, next) => (READS.includes(req.method) ? limits.readsPerPage : limits.writesPerPage)(req, res, next));

// The workspace behind the address (404 for an unknown one).
router.use(wrap(async (req, res, next) => {
  req.page = await workspaceOfPage(req.params.slug);
  next();
}));

// Each route then says which part of the page it belongs to; a part that is off answers the 404
// before anything else (the input's shape, the honeypot), so a closed page and an unknown address
// look the same on every path. The work keeps its own check inside its transaction.
const part = (name) => wrap(async (req, res, next) => {
  await checkPart(req.page, name);
  next();
});
const front = part("any");
const booking = part("booking");
const shop = part("shop");

const ws = (req) => req.page;
const answer = (fn, status = 200) => wrap(async (req, res) => res.status(status).json(await fn(req)));
// Filled honeypot: an answer that looks like the real one, and nothing saved.
const human = (fn) => (req) => (req.valid.url ? decoy() : fn(req));

router.get("/", front, answer((req) => showFront(ws(req))));

router.get("/services", booking, answer((req) => listServices(ws(req))));
router.get("/slots", booking, validate(slotsQuery, "query"), answer((req) => listSlots(ws(req), req.valid)));
router.get("/days", booking, validate(daysQuery, "query"), answer((req) => listDays(ws(req), req.valid)));
router.post("/bookings", booking, validate(bookingBody), answer(human((req) => bookVisit(ws(req), req.valid)), 201));
router.get("/bookings/:ref", booking, validate(lookupQuery, "query"), answer((req) => showBooking(ws(req), req.params.ref, req.valid.token)));
router.post("/bookings/:ref/cancel", booking, validate(tokenBody), answer((req) => cancelVisit(ws(req), req.params.ref, req.valid.token)));

router.get("/products", shop, answer((req) => listCatalogue(ws(req), req.params.slug)));
router.get("/categories", shop, answer((req) => listCategories(ws(req))));
router.get("/images/:name", shop, wrap((req, res) => sendPicture(res, ws(req), req.params.name)));
router.post("/orders", shop, validate(orderBody), answer(human((req) => placeOrder(ws(req), req.valid)), 201));
router.get("/orders/:ref", shop, validate(lookupQuery, "query"), answer((req) => showOrder(ws(req), req.params.ref, req.valid.token)));

// A path the page doesn't have: the same 404 as an unknown address.
router.use((req, res, next) => next(pageNotFound()));
