// Product photos on the cards the AI agent shows in a chat. A picture uploaded in the CRM is served
// only to the workspace's own people; a customer in the chat (and Telegram, which fetches a photo
// by its address) needs it without a session. So the chat gets its own address for the pictures
// the Store shows customers (shownToCustomers, the same rule as the shop page's), and nothing
// else: /widget/<agent key>/crm-media/<file name>.
import { Router } from "express";
import { query } from "../core/db.js";
import { notFound, wrap } from "../core/http.js";
import { uploadedName, shownToCustomers, sendImage } from "../crm/store/index.js";

const PUBLIC_API_URL = () => (process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 3100}`).replace(/\/$/, "");

/**
 * The address a customer can open a product's picture at, or null. A full web address is kept as
 * it is; a picture uploaded in the CRM goes through the chat's address; any other path (one only
 * the CRM app serves) can't be shown in a chat.
 */
export function imageUrl(access, image) {
  if (typeof image !== "string" || !image) return null;
  if (/^https?:\/\//i.test(image)) return image;
  const name = uploadedName(access.workspace.id, image);
  return name && access.agentKey ? `${PUBLIC_API_URL()}/widget/${access.agentKey}/crm-media/${name}` : null;
}

/** Mounted in the widget's router, before its origin check: a picture is fetched by an <img> or by Telegram. */
export const mediaRouter = Router({ mergeParams: true });
mediaRouter.get("/crm-media/:name", wrap(async (req, res) => {
  const agent = (await query("SELECT workspace_id FROM agents WHERE public_key = $1 AND status = 'active'", [req.params.key])).rows[0];
  if (!agent || !(await shownToCustomers(agent.workspace_id, req.params.name))) throw notFound("Picture not found");
  await sendImage(res, { id: agent.workspace_id }, req.params.name);
}));
