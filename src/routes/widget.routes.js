import { Router } from "express";
import { wrap } from "../lib/http.js";
import { validate, widgetStartSchema, widgetMessageSchema, widgetToolResultSchema } from "../validators.js";
import { rateLimit, clientIP } from "../middlewares/rateLimit.js";
import { languageOf } from "../services/suggestions.service.js";
import { widgetAgent, widgetConfig, startConversation, ownConversation, postVisitorMessage, pollMessages, requestHuman, startConnect, decide, deliverTool, visitorSees } from "../services/widget.service.js";
import { stream } from "../services/events.service.js";
import { acceptFile, visitorAttachment, sendAttachment } from "../services/attachments.service.js";

/**
 * The public API the chat widget calls from customers' websites. No cookies: a conversation
 * is proven by the visitor token returned when it starts (X-Visitor-Token header).
 */
const router = Router({ mergeParams: true });
const perIP = rateLimit({ windowMs: 60 * 1000, max: 40, key: clientIP, message: "You're sending messages too quickly. Wait a moment." });
const startsPerIP = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, key: clientIP, message: "Too many new chats from this network. Try again later." });

// The website the request comes from. Browsers leave Origin off same-site GET requests (the chat on
// the dashboard's own domain); the Referer still names the page then.
function pageOrigin(req) {
  if (req.headers.origin) return req.headers.origin;
  try {
    return new URL(req.headers.referer).origin;
  } catch {
    return undefined;
  }
}

router.use(wrap(async (req, res, next) => {
  req.agent = await widgetAgent(req.params.key, pageOrigin(req));
  next();
}));

router.get("/config", (req, res) => res.json(widgetConfig(req.agent, languageOf(req.query.lang || req.headers["accept-language"]))));
router.post("/conversations", startsPerIP, validate(widgetStartSchema), wrap(async (req, res) => {
  const visitor = { ...req.valid, user_agent: String(req.headers["user-agent"] || "").slice(0, 200) };
  res.status(201).json({ ...(await startConversation(req.agent, visitor)), config: widgetConfig(req.agent, languageOf(req.query.lang || req.headers["accept-language"])) });
}));
const token = (req) => req.headers["x-visitor-token"];
const inpage = (req) => { const o = req.headers["x-replybek-inpage"]; return typeof o === "string" && /^https?:\/\/[^/]+$/.test(o) ? o : null; };
// Live updates for one conversation: says when to fetch messages again (see events.service.js).
router.get("/conversations/:cid/stream", perIP, wrap(async (req, res) => {
  const conv = await ownConversation(req.agent, req.params.cid, token(req));
  await stream(req, res, [`c:${conv.id}`], visitorSees);
}));
// Files: at most 20 per 10 minutes from one network, on top of the message limit.
const filesPerIP = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, key: clientIP, message: "Too many files from this network. Wait a few minutes." });
const fileLimit = (req, res, next) => (req.file ? filesPerIP(req, res, next) : next());
router.post("/conversations/:cid/messages", perIP, acceptFile, fileLimit, validate(widgetMessageSchema), wrap(async (req, res) => {
  res.json(await postVisitorMessage(req.agent, req.params.cid, token(req), req.valid.text, inpage(req), req.file));
}));
// A file on this conversation's visible messages. Fetched with the token header, never by a bare URL.
const filesRead = rateLimit({ windowMs: 60 * 1000, max: 120, key: clientIP, message: "Too many requests. Wait a moment." });
router.get("/conversations/:cid/files/:fid", filesRead, wrap(async (req, res) => {
  const conv = await ownConversation(req.agent, req.params.cid, token(req));
  await sendAttachment(res, await visitorAttachment(conv, req.params.fid));
}));
router.get("/conversations/:cid/messages", perIP, wrap(async (req, res) => {
  const after = typeof req.query.after === "string" && !Number.isNaN(Date.parse(req.query.after)) ? req.query.after : null;
  res.json(await pollMessages(req.agent, req.params.cid, token(req), after));
}));
router.post("/conversations/:cid/handoff", perIP, wrap(async (req, res) => {
  res.json(await requestHuman(req.agent, req.params.cid, token(req)));
}));

// Integrations: where to sign in, and the customer's answer to a proposed change.
router.post("/conversations/:cid/integrations/:iid/connect", perIP, wrap(async (req, res) => {
  res.json(await startConnect(req.agent, req.params.cid, token(req), req.params.iid));
}));
router.post("/conversations/:cid/actions/:aid/:decision(confirm|cancel)", perIP, wrap(async (req, res) => {
  res.json(await decide(req.agent, req.params.cid, token(req), req.params.aid, req.params.decision === "confirm", inpage(req)));
}));

// The widget delivers the result of an in-page request it ran for a tool call.
router.post("/conversations/:cid/tool-calls/:tid", perIP, validate(widgetToolResultSchema), wrap(async (req, res) => {
  res.json(await deliverTool(req.agent, req.params.cid, token(req), req.params.tid, { status: req.valid.status, body: req.valid.body }));
}));

export default router;
