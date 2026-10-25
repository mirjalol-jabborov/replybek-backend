import express from "express";
import cors from "cors";
import morgan from "morgan";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import notFound from "./middlewares/notFound.js";
import error from "./middlewares/error.js";
import { requireUser, requireJsonForWrites } from "./middlewares/session.js";
import authRoutes from "./routes/auth.routes.js";
import workspaceRoutes from "./routes/workspace.routes.js";
import widgetRoutes from "./routes/widget.routes.js";
import oauthRoutes from "./routes/oauth.routes.js";
import "./services/ingest.service.js"; // registers the ingest job

const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY === "true" ? true : process.env.TRUST_PROXY);
if (process.env.NODE_ENV !== "test") app.use(morgan("dev"));

app.get("/health", (req, res) => res.json({ ok: true }));

// Serves the built chat widget so a host page (or the Biruni plugin) can load it from one URL.
const widgetFile = process.env.WIDGET_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), "../../replybek-widget/dist/replybek-widget.js");
app.get(["/widget.js", "/replybek-widget.js"], (req, res) => {
  fs.readFile(widgetFile, (err, data) => {
    if (err) return res.status(404).type("text/plain").send("// widget not built");
    res.type("application/javascript").set("Cache-Control", "public, max-age=300").send(data);
  });
});

// The widget runs on customers' sites: any origin may call it (each agent can limit its origins),
// and it never uses cookies.
app.use("/widget/:key", cors({ origin: true, credentials: false }), express.json({ limit: "640kb" }), widgetRoutes);

// Where an integration's sign-in page sends the customer back. A plain page, no CORS or cookies.
app.use("/oauth", oauthRoutes);

// The dashboard: only APP_ORIGIN, with the session cookie.
const appOrigin = process.env.APP_ORIGIN || "http://localhost:5173";
app.use(cors({ origin: appOrigin, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(requireJsonForWrites);
app.use("/auth", authRoutes);
app.use("/w/:wid", requireUser, workspaceRoutes);

app.use(notFound);
app.use(error);

export default app;
