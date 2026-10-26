import { Router } from "express";
import express from "express";
import { wrap } from "../lib/http.js";
import { verifyWebhook } from "../lib/polar.js";
import { handlePolarEvent } from "../services/billing.service.js";

// Polar's server calls this, not a browser: no CORS or cookies. The signature covers the raw bytes,
// so the body is read raw and parsed only after it checks out.
const router = Router();

router.post("/polar/webhook", express.raw({ type: "*/*", limit: "1mb" }), wrap(async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  if (!verifyWebhook(raw, req.headers)) return res.status(401).json({ message: "Invalid signature." });
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return res.status(400).json({ message: "Body isn't JSON." });
  }
  res.json(await handlePolarEvent(req.get("webhook-id"), event));
}));

export default router;
