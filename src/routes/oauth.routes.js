import { Router } from "express";
import { completeConnect } from "../services/integrations.service.js";
import { afterConnect } from "../services/widget.service.js";

/**
 * The page an integration's sign-in returns to (the OAuth redirect URI). It saves the customer's
 * token, tells the chat window it can continue, and closes itself.
 */
const router = Router();

const page = (ok, text) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ok ? "Signed in" : "Sign-in failed"}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f8;color:#1d2125}
main{max-width:360px;padding:24px;text-align:center}h1{font-size:18px;margin:0 0 8px}</style></head>
<body><main><h1>${ok ? "✓" : "!"} ${text}</h1><p>${ok ? "You can close this window and go back to the chat." : "Close this window and try again from the chat."}</p></main>
<script>try{window.opener&&window.opener.postMessage({type:"replybek:connected",ok:${ok}},"*")}catch(e){}${ok ? "setTimeout(function(){window.close()},1200)" : ""}</script></body></html>`;

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

router.get("/callback", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const { conversationId, integration, label } = await completeConnect({ code: req.query.code, state: req.query.state, error: req.query.error });
    res.send(page(true, escape(label ? `Signed in as ${label}` : `Signed in to ${integration.name}`)));
    // Answer the waiting question in the background; the widget picks it up by polling.
    afterConnect(conversationId, label, integration.name).catch((e) => console.error("After sign-in:", e.message));
  } catch (e) {
    res.status(e.status || 500).send(page(false, escape(e.status ? e.message : "Something went wrong.")));
  }
});

export default router;
