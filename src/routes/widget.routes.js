import { Router } from "express";
import { wrap } from "../lib/http.js";
import { validate, widgetStartSchema, widgetMessageSchema, widgetToolResultSchema } from "../validators.js";
import { rateLimit, clientIP } from "../middlewares/rateLimit.js";
import { widgetAgent, widgetConfig, startConversation, postVisitorMessage, pollMessages, requestHuman, startConnect, decide, deliverTool } from "../services/widget.service.js";

/**
 * The public API the chat widget calls from customers' websites. No cookies: a conversation
 * is proven by the visitor token returned when it starts (X-Visitor-Token header).
 */
const router = Router({ mergeParams: true });
const perIP = rateLimit({ windowMs: 60 * 1000, max: 40, key: clientIP, message: "You're sending messages too quickly. Wait a moment." });
const startsPerIP = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, key: clientIP, message: "Too many new chats from this network. Try again later." });

router.use(wrap(async (req, res, next) => {
  req.agent = await widgetAgent(req.params.key, req.headers.origin);
  next();
}));

router.get("/config", (req, res) => res.json(widgetConfig(req.agent)));
router.post("/conversations", startsPerIP, validate(widgetStartSchema), wrap(async (req, res) => {
  const visitor = { ...req.valid, user_agent: String(req.headers["user-agent"] || "").slice(0, 200) };
  res.status(201).json({ ...(await startConversation(req.agent, visitor)), config: widgetConfig(req.agent) });
}));
const token = (req) => req.headers["x-visitor-token"];
const inpage = (req) => { const o = req.headers["x-replybek-inpage"]; return typeof o === "string" && /^https?:\/\/[^/]+$/.test(o) ? o : null; };
router.post("/conversations/:cid/messages", perIP, validate(widgetMessageSchema), wrap(async (req, res) => {
  res.json(await postVisitorMessage(req.agent, req.params.cid, token(req), req.valid.text, inpage(req)));
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
