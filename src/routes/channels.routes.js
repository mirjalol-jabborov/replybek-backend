import crypto from "crypto";
import { Router } from "express";
import { wrap } from "../lib/http.js";
import { loadChannel } from "../services/channels.service.js";
import { handleUpdate } from "../services/telegram.service.js";

/**
 * Where messaging platforms deliver what customers write. Telegram redelivers an update until it
 * is acknowledged, so every update is answered 200 as soon as it is accepted and handled after:
 * a failure here must never turn into the same message being sent to a customer twice.
 */
const router = Router();

const sameSecret = (given, expected) => {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(String(expected || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

router.post("/telegram/:channelId", wrap(async (req, res) => {
  const channel = await loadChannel(req.params.channelId);
  if (!channel || !sameSecret(req.get("X-Telegram-Bot-Api-Secret-Token"), channel.secret)) {
    return res.status(401).json({ error: "Unknown channel." });
  }
  res.json({ ok: true });
  // After the acknowledgement: Telegram should not wait for an answer to be written, and must
  // not retry an update that is already being handled.
  handleUpdate(channel, req.body || {}).catch((e) => console.error(`Telegram update failed on channel ${channel.id}:`, e.message));
}));

export default router;
