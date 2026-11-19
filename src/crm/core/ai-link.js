// Which Replybek AI agent works in this CRM, where, and how far (settings.ai). The CRM owns the
// choice; the bridge (src/bridge/access.js) reads it to decide which tools an answer gets.
//
//   settings.ai = { agentId: uuid | null, channels: { widget, telegram }, booking: level, store: level, cart?, productUrl? }
//   level: "off" (no tools for the module), "answer" (lookups only), "act" (lookups and changes,
//   each one confirmed by the customer)
//   cart: { mode: "chat" | "site", url } (optional): where a product card's "Add to cart" puts
//   things. "chat": the chat's own cart, which the agent orders. "site": the website's own cart, at
//   `url` (the widget posts { product, variant, qty, title } there from a page of that site; on
//   any other page, and in Telegram, the chat's cart). Rows without it read as "chat".
//   productUrl (optional): the address of a product's page on the business's website, with {id}
//   (the CRM's product id) or {sku} where it goes: "https://shop.uz/product/{id}". A product card
//   in the chat opens it. Without it a card opens the product on the CRM's own shop page, when
//   that is on (src/bridge/store.js). Rows without it have none.
//
// Workspaces from before keep only settings.aiConnected / settings.aiAct. They are read through
// aiLink() without any migration: connected meant every agent on every channel, so it reads as the
// oldest published agent (else the oldest one) on both channels, at "act" (or "answer" when aiAct
// was off) for each module that is on. A save in the new shape keeps both old keys in step
// (mirrorOldKeys); a save in the old shape (aiConnected/aiAct without ai) drops `ai`, so the old
// keys are read again.
import { z } from "zod";
import { uuid } from "../shapes.js";

export const LEVELS = ["off", "answer", "act"];
const MODULES = ["booking", "store"];

/** settings.ai as PUT /settings takes it. Saved whole. */
export const aiShape = z
  .object({
    agentId: uuid.nullable(),
    channels: z.object({ widget: z.boolean(), telegram: z.boolean() }).strict(),
    booking: z.enum(LEVELS),
    store: z.enum(LEVELS),
    cart: z
      .object({ mode: z.enum(["chat", "site"]), url: z.string().trim().max(500) })
      .strict()
      .refine((c) => c.mode !== "site" || c.url, { message: "Give the address of your website's cart.", path: ["url"] })
      .refine((c) => !c.url || cartUrlOk(c.url), { message: "The cart's address must start with https:// (http:// only for localhost).", path: ["url"] })
      .optional(),
    productUrl: z
      .string()
      .trim()
      .max(300)
      .refine((v) => !v || productUrlOk(v), { message: "Write the address with {id} where the product's id goes, starting with https://.", path: [] })
      .optional(),
  })
  .strict();

/** The placeholders a product page address may have: {id} (the CRM's product id) and {sku}. */
const PLACEHOLDER = /\{(id|sku)\}/g;

/** A product page address the cards may open: https (http on this computer), at most 300 characters, with {id} or {sku}. */
export function productUrlOk(template) {
  if (typeof template !== "string" || template.length > 300 || !/\{(id|sku)\}/.test(template)) return false;
  return cartUrlOk(template.replace(PLACEHOLDER, "x"));
}

/**
 * A product's page from the saved address, or null: when it has no address, the address is wrong,
 * or it asks for a {sku} the product doesn't have. Each value goes in encoded, so a product can't
 * change where the address points.
 */
export function fillProductUrl(template, { id, sku } = {}) {
  if (!productUrlOk(template)) return null;
  const values = { id, sku };
  let missing = false;
  const url = template.replace(PLACEHOLDER, (_, key) => {
    const v = values[key] == null ? "" : String(values[key]).trim();
    if (!v) missing = true;
    return encodeURIComponent(v);
  });
  return missing ? null : url;
}

/** A website cart address the widget may post to: https, or http on this computer. */
export function cartUrlOk(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname));
  } catch {
    return false;
  }
}

/** Where "Add to cart" puts things, as saved or the default: { mode, url }. `saved`: a link's `cart`, maybe missing. */
export const cartOf = (saved) => (saved?.mode === "site" && saved.url && cartUrlOk(saved.url) ? { mode: "site", url: saved.url } : { mode: "chat", url: saved?.url || "" });

/**
 * The workspace's agents the link can name, oldest first: [{ id, name, status }]. Empty without
 * the agent product (nothing to connect to, and no query).
 */
export async function agentsOf(q, workspace) {
  if (!(workspace.products || []).includes("agent")) return [];
  const { rows } = await q("SELECT id, name, status FROM agents WHERE workspace_id = $1 ORDER BY created_at, id", [workspace.id]);
  return rows;
}

/**
 * The link as it holds now: settings.ai when saved, else what aiConnected / aiAct meant. An agent
 * that is gone (deleted, or never this workspace's) reads as not connected. `agents` from agentsOf.
 */
export function aiLink(settings, modules, agents) {
  const ids = new Set(agents.map((a) => a.id));
  const saved = settings.ai;
  if (saved && typeof saved === "object") {
    return {
      agentId: ids.has(saved.agentId) ? saved.agentId : null,
      channels: { widget: saved.channels?.widget !== false, telegram: saved.channels?.telegram !== false },
      booking: LEVELS.includes(saved.booking) ? saved.booking : "off",
      store: LEVELS.includes(saved.store) ? saved.store : "off",
      ...(saved.cart ? { cart: cartOf(saved.cart) } : {}),
      ...(productUrlOk(saved.productUrl) ? { productUrl: saved.productUrl } : {}),
    };
  }
  const level = settings.aiAct === false ? "answer" : "act";
  const chosen = settings.aiConnected ? agents.find((a) => a.status === "active") || agents[0] : null;
  return {
    agentId: chosen?.id || null,
    channels: { widget: true, telegram: true },
    ...Object.fromEntries(MODULES.map((m) => [m, modules?.[m] ? level : "off"])),
  };
}

/** What each module's AI agent may do now: the saved level, "off" for a module that is off. */
export const levelsOf = (ai, modules) => Object.fromEntries(MODULES.map((m) => [m, modules?.[m] ? ai[m] : "off"]));

/**
 * The old keys for a link saved in the new shape, so code that still reads only them (a rollback)
 * never gives the agent more than the link does: connected only with an agent, a channel and a
 * module that isn't off; writes only when no module is held at "answer".
 */
export function mirrorOldKeys(ai) {
  const levels = MODULES.map((m) => ai[m]);
  return {
    aiConnected: Boolean(ai.agentId) && (ai.channels.widget || ai.channels.telegram) && levels.some((l) => l !== "off"),
    aiAct: !levels.includes("answer"),
  };
}
