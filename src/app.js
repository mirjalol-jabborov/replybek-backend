import express, { Router } from "express";
import cors from "cors";
import morgan from "morgan";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { finishBrowserTest } from "./agent/integrations/testing.js";
import { validate } from "./core/validate.js";
import { widgetToolResultSchema } from "./agent/integrations/checks.js";
import { wrap } from "./core/http.js";
import notFound from "./core/not-found.js";
import error from "./core/error.js";
import { requireUser, requireJsonForWrites, appOrigins } from "./core/auth/session.js";
import authRoutes from "./core/auth/routes.js";
import * as teamRoutes from "./core/team/invite-routes.js";
import widgetRoutes from "./agent/channels/widget-routes.js";
import oauthRoutes from "./agent/integrations/oauth-routes.js";
import billingRoutes from "./core/billing/polar-routes.js";
import channelsRoutes from "./agent/channels/telegram-routes.js";
import "./agent/knowledge/ingest.js"; // registers the ingest job
import { requireWorkspace, requireProduct, agentRoutesNeedAgent, readOnlyUntilTrial } from "./core/workspaces/access.js";
import workspace, { products } from "./core/workspaces/routes.js";
import team from "./core/team/routes.js";
import activity from "./core/activity/routes.js";
import billing from "./core/billing/routes.js";
import analytics from "./agent/analytics/routes.js";
import onboarding from "./agent/onboarding/routes.js";
import agents from "./agent/agents/routes.js";
import channels from "./agent/channels/routes.js";
import answers from "./agent/answers/routes.js";
import knowledge from "./agent/knowledge/routes.js";
import inbox from "./agent/inbox/routes.js";
import integrations from "./agent/integrations/routes.js";
import crmRoutes from "./crm/index.js";
import { crmRouter as crmAgentLink, agentRouter as agentCrmLink } from "./bridge/link.js";
import "./agent/channels/notice-sender.js"; // the Telegram bot as a way the CRM's messages reach a customer
import { router as crmPageRoutes } from "./crm/public/page-routes.js";

// Everything here is scoped to /w/:wid, and every query filters by that workspace. Each area's
// routes keep the order they always had; what sits above readOnlyUntilTrial stays open while locked.
const workspaceRoutes = Router({ mergeParams: true });
workspaceRoutes.use(requireWorkspace);
// A workspace has the AI agent, the CRM or both. The agent's routes below are closed to a workspace without it.
workspaceRoutes.use(agentRoutesNeedAgent);
// Adding a product and the whole CRM sit above the trial lock: the CRM isn't billed yet.
workspaceRoutes.use(products);
workspaceRoutes.use("/crm", requireProduct("crm"), crmAgentLink, crmRoutes);
workspaceRoutes.use(readOnlyUntilTrial);
workspaceRoutes.use(workspace, team, activity, analytics, billing, onboarding, agents, agentCrmLink, channels, answers, knowledge, inbox, integrations);

const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY === "true" ? true : process.env.TRUST_PROXY);
if (process.env.NODE_ENV !== "test") app.use(morgan("dev"));

app.get("/health", (req, res) => res.json({ ok: true }));

// Serves the built chat widget so any host page can load it from one URL.
const widgetFile = process.env.WIDGET_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), "../../replybek-widget/dist/replybek-widget.js");
app.get(["/widget.js", "/replybek-widget.js"], (req, res) => {
  fs.readFile(widgetFile, (err, data) => {
    if (err) return res.status(404).type("text/plain").send("// widget not built");
    res.type("application/javascript; charset=utf-8").set("Cache-Control", "public, max-age=300").send(data);
  });
});

// The widget runs on customers' sites: any origin may call it (each agent can limit its origins),
// and it never uses cookies.
app.use("/widget/:key", cors({ origin: true, credentials: false }), express.json({ limit: "640kb" }), widgetRoutes);

// A business's own booking and shop pages: open to anyone, never a cookie (see src/crm/public/page-routes.js).
app.use("/public/crm/:slug", crmPageRoutes);

// Where an integration's sign-in page sends the customer back. A plain page, no CORS or cookies.
app.use("/oauth", oauthRoutes);

// Messaging platforms deliver customers' messages here: signed server-to-server calls with the
// channel's own secret, no cookies and no CORS.
app.use("/channels", express.json({ limit: "256kb" }), channelsRoutes);

// Polar's billing webhooks: signed server-to-server calls, read raw before any JSON parsing.
app.use("/billing", billingRoutes);

// Short-lived, one-use browser test token. No dashboard cookies cross origins.
app.options("/integration-tests/result", cors({origin:true,credentials:false}));
app.post("/integration-tests/result", cors({origin:true,credentials:false}), express.json({limit:"32kb"}), validate(widgetToolResultSchema), wrap(async (req,res) => res.json(await finishBrowserTest(req.get("X-Replybek-Test"),req.get("Origin"),req.valid))));

// The dashboard and the CRM: only the addresses in APP_ORIGIN, with the session cookie.
app.use(cors({ origin: appOrigins(), credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(requireJsonForWrites);
app.use("/auth/password", teamRoutes.password);
app.use("/auth", authRoutes);
app.use("/invites", teamRoutes.invites);
app.use("/w/:wid", requireUser, workspaceRoutes);

app.use(notFound);
app.use(error);

export default app;
