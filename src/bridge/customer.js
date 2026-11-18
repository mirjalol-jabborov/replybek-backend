// Who the customer in a chat is to the CRM, and what of the CRM is theirs. The rule lives here,
// not in the prompt: a conversation sees and changes only its own customer's bookings and orders.
// Anyone can type a phone number, so only a customer the channel vouches for (the team saved their
// Telegram handle) sees everything filed for them; one known by a typed phone, or added from one,
// sees only what their own chats made, and is never told whether the number was already a
// customer's. See crm_bridge_links in sql/crm/50-bridge.sql.
import { query } from "../core/db.js";
import { read, asQ } from "../crm/db.js";
import { findCustomer, findOrAddCustomer } from "../crm/core/customers.js";
import { bookedByCustomerToday } from "../crm/booking/index.js";
import { orderedByCustomerToday } from "../crm/store/index.js";
import { normalPhone, PER_PHONE_PER_DAY } from "../crm/shared/index.js";

const COLS = "customer_id, proof, channel_key, name, phone";

/** The channel's own proof of who someone is: their Telegram account. Null on the website. */
function channelKey(access) {
  const id = access.visitor?.telegram_user_id;
  return String(access.channel || "").startsWith("telegram") && id ? `telegram:${id}` : null;
}

/** Saves the conversation's link. `q`: a plain query, or a write's client inside its transaction. */
async function saveLink(q, access, link) {
  const { rows } = await q(
    `INSERT INTO crm_bridge_links (workspace_id, conversation_id, customer_id, proof, channel_key, name, phone)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (workspace_id, conversation_id) DO UPDATE SET customer_id = EXCLUDED.customer_id, proof = EXCLUDED.proof,
       channel_key = EXCLUDED.channel_key, name = EXCLUDED.name, phone = EXCLUDED.phone, updated_at = now()
     RETURNING ${COLS}`,
    [access.workspace.id, access.conversationId, link.customer_id || null, link.proof || "none", channelKey(access), link.name || "", link.phone || ""]
  );
  return rows[0];
}

/**
 * The customer the channel vouches for: the one customer the team saved this Telegram account's
 * handle on, now. A handle the AI agent saved on a customer it added (source "ai") came with a
 * typed phone, so it vouches for nothing; two customers with one handle, nobody (findCustomer).
 * Asked every time a link is used, so a handle the team clears or moves takes the trust with it.
 */
async function vouchedId(access) {
  const handle = channelKey(access) && access.visitor?.telegram_username;
  return (handle && (await read(access.workspace.id, (q, cfg) => findCustomer(q, cfg, { telegram: handle, notFrom: "ai" })))?.id) || null;
}

/**
 * Who this Telegram account is, from what is known already: { customer_id, proof, name?, phone? } or null.
 * The channel vouches (proof "channel") for the customer the team saved the handle on. Else the
 * account's earlier link by a phone counts again with the proof it had, so its own items stay
 * theirs and nothing more.
 */
async function byChannel(access, key, link) {
  const saved = await vouchedId(access);
  if (saved) return { customer_id: saved, proof: "channel" };
  const before = (
    await query(
      "SELECT customer_id, proof, name, phone FROM crm_bridge_links WHERE workspace_id = $1 AND channel_key = $2 AND customer_id IS NOT NULL AND proof <> 'channel' ORDER BY updated_at DESC LIMIT 1",
      [access.workspace.id, key]
    )
  ).rows[0];
  // The same account typed another phone in this chat already: that one counts, not the earlier.
  if (!before || (link?.phone && link.phone !== before.phone)) return null;
  return before;
}

/**
 * The conversation's link, made from the channel when it has none yet. Null when nothing is known.
 * A `channel` link holds only while the handle is still that customer's; once it isn't, the chat
 * is known as the channel says now, or not at all (it is not saved, so the link's items stay its own).
 */
export async function currentLink(access) {
  if (!access.conversationId) return null;
  const stored = (await query(`SELECT ${COLS} FROM crm_bridge_links WHERE workspace_id = $1 AND conversation_id = $2`, [access.workspace.id, access.conversationId])).rows[0] || null;
  if (stored?.customer_id && (stored.proof !== "channel" || (await vouchedId(access)) === stored.customer_id)) return stored;
  const link = stored?.customer_id ? { ...stored, customer_id: null, proof: "none" } : stored;
  const key = channelKey(access);
  const found = key && (await byChannel(access, key, link));
  return found ? saveLink(query, access, { ...link, ...found }) : link;
}

/** The id of the customer who has this number, or null. */
const phoneOwner = async (q, cfg, phone) => (await findCustomer(q, cfg, { phone }))?.id || null;

const vouched = (link) => Boolean(link?.customer_id) && link.proof === "channel";

/**
 * What is still missing before the AI agent can act for this customer: [], ["name"], ["phone"] or
 * both. Anyone not vouched for by the channel gives a name and a phone, whether or not the phone is
 * already a customer's, so the answers never tell the two apart.
 */
function missing(link) {
  if (vouched(link)) return [];
  return [...(link?.name ? [] : ["name"]), ...(link?.phone ? [] : ["phone"])];
}
/** Enough is known to act for the customer. */
export const ready = (link) => Boolean(link) && missing(link).length === 0;
export const unknown = (link) => ({ error: "customer_unknown", missing: missing(link).length ? missing(link) : ["name", "phone"] });

/**
 * The crm_identify_customer tool: links the chat to a customer by the phone (and name) they gave,
 * or what the chat already knows (the page's or Telegram's). A new customer is only remembered
 * here: they are added to the CRM when they confirm their first booking or order.
 * Answers { customer: "known", name } when the channel vouches for them, { customer: "ready" } when
 * the name and phone are in (the same whether the phone was a customer's or not), or
 * { error: customer_unknown | bad_phone, missing? }.
 */
export async function identify(access, args) {
  if (!access.conversationId) return { error: "no_conversation" };
  const link = await currentLink(access);
  const given = args.phone ? normalPhone(args.phone) : null;
  if (args.phone && !given) return { error: "bad_phone" };
  if (vouched(link)) {
    const known = await read(access.workspace.id, (q, cfg) => findCustomer(q, cfg, { id: link.customer_id }));
    return { customer: "known", name: known.name };
  }
  const phone = given || link?.phone || normalPhone(access.visitor?.phone) || "";
  const name = String(args.name || link?.name || access.visitor?.name || "").trim().slice(0, 120);
  if (!phone) {
    if (name) await saveLink(query, access, { ...link, name });
    return { error: "customer_unknown", missing: name ? ["phone"] : ["name", "phone"] };
  }
  // The same phone as before keeps its customer and proof; another one is looked up. A number typed
  // in the chat proves nothing: they act for its customer, but see only what their own chats made.
  const same = link?.customer_id && phone === link.phone;
  const owner = same ? link.customer_id : await read(access.workspace.id, (q, cfg) => phoneOwner(q, cfg, phone));
  await saveLink(query, access, { customer_id: owner || null, proof: same ? link.proof : owner ? "phone" : "none", name, phone });
  return name ? { customer: "ready" } : { error: "customer_unknown", missing: ["name"] };
}

/**
 * Who the customer is to a module's write: a customer acting for themselves through the AI agent.
 * One the channel vouches for has no daily share; one known by a typed phone has the pages' one.
 */
export const asCustomer = (link) => ({ by: "customer", via: "ai", source: "ai", capped: !vouched(link) });

/**
 * Inside a confirmed write: the customer the item is for. One only remembered (name and phone) is
 * found by that phone now, or added with source "ai" (and, on Telegram, the chat's handle).
 * Returns { id, added } (added: the new customer's row, or null).
 */
export async function ensureCustomer(c, cfg, access, link) {
  if (link.customer_id) return { id: link.customer_id, added: null };
  const handle = channelKey(access) ? access.visitor.telegram_username || "" : "";
  const found = await findOrAddCustomer(c, cfg, { name: link.name, phone: link.phone, telegram: handle }, "ai");
  await saveLink(asQ(c), access, { ...link, customer_id: found.id, proof: found.added ? "new" : "phone" });
  return found;
}

/**
 * Whether this customer made their day's share of bookings ("appointment") or orders ("order")
 * themselves already, on the pages and in chats together (the modules count it, and refuse the
 * write past it). A customer the channel vouches for has no share; one not added yet has made none.
 */
export async function capReached(q, cfg, link, item) {
  if (vouched(link) || !link?.customer_id) return false;
  const made = item === "appointment" ? await bookedByCustomerToday(q, cfg, link.customer_id) : await orderedByCustomerToday(q, cfg, link.customer_id);
  return made >= PER_PHONE_PER_DAY;
}
/** The share's refusal, as an answer before the card. */
export const capAnswer = () => ({ error: "phone_limit", max: PER_PHONE_PER_DAY });

/** Remembers that this conversation made a booking or an order: what a link not vouched for may see. */
export const rememberItem = (q, access, item, id) =>
  q("INSERT INTO crm_bridge_items (workspace_id, conversation_id, item, item_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [access.workspace.id, access.conversationId, item, id]);

/**
 * Which of a customer's rows this conversation may see: a test for one row. A row of another
 * customer never passes. Unless the channel vouches for the customer, only rows their own chats
 * made pass: this conversation's, and on Telegram those of the same account's other chats.
 */
export async function mineTest(q, access, link, item) {
  if (!link?.customer_id) return () => false;
  let made = null;
  if (!vouched(link)) {
    const { rows } = await q(
      `SELECT i.item_id FROM crm_bridge_items i
        WHERE i.workspace_id = $1 AND i.item = $3 AND i.conversation_id IN (
          SELECT l.conversation_id FROM crm_bridge_links l
           WHERE l.workspace_id = $1 AND (l.conversation_id = $2 OR (l.channel_key = $4 AND l.customer_id = $5)))`,
      [access.workspace.id, access.conversationId, item, channelKey(access), link.customer_id]
    );
    made = new Set(rows.map((r) => r.item_id));
  }
  return (row) => Boolean(row) && row.customerId === link.customer_id && (!made || made.has(row.id));
}
