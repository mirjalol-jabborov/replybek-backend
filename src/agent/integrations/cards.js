import { query } from "../../core/db.js";
import { HttpError, notFound } from "../../core/http.js";
import { pick } from "./template.js";
import { runTool } from "./tools.js";

/**
 * A tool's result as cards for the chat, when the tool says how (its `display`): a photo, a name,
 * a price and a link for each item, at most `max`. Only web addresses are kept, so a result can't
 * put anything else in front of the customer. Null when there is nothing to show.
 */
export function displayCard(display, output, source = {}) {
  if (!display || output == null || output.error) return null;
  let list = pick(output, display.items || "");
  if (list && !Array.isArray(list)) list = [list];
  if (!Array.isArray(list)) return null;
  const web = (v) => (typeof v === "string" && /^https?:\/\//i.test(v) ? v.slice(0, 600) : null);
  const str = (v, n) => (v == null || typeof v === "object" ? null : String(v).trim().slice(0, n) || null);
  const items = list
    .slice(0, display.max || 6)
    .map((item) => {
      const price = pick(item, display.price);
      return {
        title: str(pick(item, display.title), 120),
        image: web(pick(item, display.image)),
        subtitle: str(pick(item, display.subtitle), 140),
        price: typeof price === "number" ? Math.round(price) : str(price, 40),
        currency: display.currency || null,
        url: web(pick(item, display.url)),
        ...(display.id ? { id: str(pick(item, display.id), 80) } : {}),
        ...(display.action ? { args: actionArgs(display.action.args, item) } : {}),
      };
    })
    .filter((i) => i.title);
  if (!items.length) return null;
  // An integration's button runs its write tool; the built-in CRM's ("Add to cart") has none (crm: true).
  const crm = display.action?.crm === true && source.crm === true;
  const action = display.action && (source.integration_id || crm)
    ? { integration_id: crm ? null : source.integration_id, tool: display.action.tool, label: display.action.label, done: display.action.done || null, ...(display.action.quantity ? { quantity: display.action.quantity } : {}), ...(display.action.max ? { max: display.action.max } : {}), ...(crm ? { crm: true } : {}) }
    : null;
  return { type: "products", items, ...(display.layout === "list" ? { layout: "list" } : {}), ...(action ? { action } : {}) };
}

// A card button's inputs: a string is a field of the item ("id"), anything else a fixed value.
function actionArgs(map = {}, item) {
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    const val = typeof v === "string" ? pick(item, v) : v;
    if (val != null && typeof val !== "object") out[k] = typeof val === "string" ? val.slice(0, 300) : val;
  }
  return out;
}

/**
 * The customer tapped a card's button: runs the card's write action for that item. The inputs come
 * from the business's own result, not from the AI, and the button names the item, so the tap
 * stands in for Confirm. Returns the pending action's id (already claimed by the caller's decide).
 */
export async function queueCardAction(agentId, conversationId, card, index, inpageOrigin = null, qty = null) {
  const item = card?.type === "products" ? card.items?.[index] : null;
  if (!item || !card.action || !item.args) throw notFound("This button is no longer available.");
  const integration = (await query("SELECT * FROM integrations WHERE id = $1 AND agent_id = $2 AND enabled", [card.action.integration_id, agentId])).rows[0];
  const tool = (integration?.tools || []).find((t) => t.name === card.action.tool && t.kind === "write");
  if (!tool) throw notFound("This button is no longer available.");
  // How many, when the card lets the customer choose: a whole number from 1 to 99, nothing else.
  const args = card.action.quantity ? { ...item.args, [card.action.quantity]: Math.min(99, Math.max(1, Math.round(Number(qty) || 1))) } : item.args;
  const res = await runTool({ conversationId, integration, tool, args, inpageOrigin });
  if (!res.card?.action_id) throw new HttpError(400, res.output?.message || "This button can't be used here.");
  return res.card.action_id;
}
