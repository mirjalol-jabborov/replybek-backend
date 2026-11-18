import { Router } from "express";
import { wrap } from "../../core/http.js";
import { validate } from "../../core/validate.js";
import { requireRole } from "../../core/workspaces/access.js";
import { telegramChannelSchema, telegramBotSchema } from "./checks.js";
import { listChannels, connectTelegram, disconnectChannel } from "./channels.js";
import { botProfile, updateBot } from "./bot-profile.js";
import { businessStatus, startBusinessLink, unlinkBusiness } from "./business-setup.js";

const router = Router({ mergeParams: true });
const admin = requireRole("admin");

// Channels: where an agent answers besides its own website widget.
router.get("/agents/:aid/channels", wrap(async (req, res) => res.json(await listChannels(req.workspace.id, req.params.aid))));
router.post("/agents/:aid/channels/telegram", admin, validate(telegramChannelSchema), wrap(async (req, res) => {
  res.status(201).json(await connectTelegram(req.workspace, req.params.aid, req.user, req.valid.bot_token));
}));
router.get("/agents/:aid/channels/:cid/bot", wrap(async (req, res) => res.json(await botProfile(req.workspace.id, req.params.aid, req.params.cid))));
router.patch("/agents/:aid/channels/:cid/bot", admin, validate(telegramBotSchema), wrap(async (req, res) => res.json(await updateBot(req.workspace.id, req.params.aid, req.params.cid, req.user, req.valid))));
// Telegram Business on the same bot: where the setup stands, the owner's one-time link, and turning it off.
router.get("/agents/:aid/channels/:cid/business", wrap(async (req, res) => res.json(await businessStatus(req.workspace.id, req.params.aid, req.params.cid))));
router.post("/agents/:aid/channels/:cid/business/link", admin, wrap(async (req, res) => res.json(await startBusinessLink(req.workspace.id, req.params.aid, req.params.cid, req.user))));
router.delete("/agents/:aid/channels/:cid/business", admin, wrap(async (req, res) => res.json(await unlinkBusiness(req.workspace.id, req.params.aid, req.params.cid, req.user))));
router.delete("/agents/:aid/channels/:cid", admin, wrap(async (req, res) => res.json(await disconnectChannel(req.workspace.id, req.params.aid, req.params.cid, req.user))));

export default router;
