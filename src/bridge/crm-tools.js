// The bridge (src/bridge) is the one place where the AI agent and the CRM meet. The agent's code
// asks three things here: which CRM tools an answer may use (crmTools), to run one (runCrmTool),
// and what happened when the customer pressed Confirm or Cancel on a CRM card (decideCrmAction);
// its widget router also mounts the photo route (media.js). The CRM's code never imports this
// folder, and the agent's code imports the CRM only through it.
//
// The tools exist only for the agent the business chose in CRM settings (settings.ai), on the
// channels it allowed, for each module at the level it set: "answer" gives the lookups, "act" also
// the changes (access.js). Otherwise crmTools() is empty and the agent answers exactly as without a CRM.
// Every change waits for the customer's Confirm on a card (pending_actions with source 'crm'),
// and the CRM's rules are asked again when they press it. A newer card for the same change takes
// the older one's place. Answers to the agent are codes.
import Ajv from "ajv";
import { query } from "../core/db.js";
import { HttpError } from "../core/http.js";
import { forCustomer } from "../crm/shared/customer.js";
import { settleCard } from "../agent/inbox/delivery.js";
import { crmAccess } from "./access.js";
import { currentLink, identify, ready, unknown } from "./customer.js";
import { unrealDates } from "./inputs.js";
import { tools as bookingTools } from "./booking.js";
import { tools as storeTools } from "./store.js";
import { langOf } from "./wording.js";

const identifyTool = {
  name: "crm_identify_customer",
  module: null,
  kind: "read",
  description:
    "Says who the customer is to the business, so their bookings and orders are theirs. Give the phone number and name the customer wrote. Answers { customer: \"known\", name } when their chat account is on the customer's record, { customer: \"ready\" } when you can book and order for them, { error: \"customer_unknown\", missing: [\"name\", \"phone\"] } (ask for what is missing) or { error: \"bad_phone\" }. It never says whether a phone is already a customer's; the customer sees the bookings and orders made in their own chats.",
  when: "Another crm tool answered customer_unknown, or the customer gives their phone or name to book, order or see their own bookings and orders.",
  input: { type: "object", properties: { phone: { type: "string", maxLength: 40 }, name: { type: "string", maxLength: 120 } }, additionalProperties: false },
  run: identify,
};

const TOOLS = [identifyTool, ...bookingTools, ...storeTools];
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// Every tool also takes the language the agent replies in: cards and names come in it.
const LANGUAGE = { type: "string", enum: ["en", "ru", "uz"], description: "The language you are replying in." };
const modelInput = (input) => ({ ...input, properties: { ...input.properties, language: LANGUAGE } });
const ajv = new Ajv({ strict: false, allErrors: true });
const checks = new Map(TOOLS.map((t) => [t.name, ajv.compile(modelInput(t.input))]));

/** Whether this workspace's CRM, as it is now, offers the tool. */
const offered = (tool, access) => (!tool.module || access.modules[tool.module]) && (tool.kind !== "write" || access.act[tool.module]);

/**
 * The CRM tools an answer may use, in the shape the agent's own tools have:
 * [{ integration: { id: null, name, crm: true }, tool: { name, description, when, kind, input, display? } }].
 * Empty when the AI agent may not work in this workspace's CRM.
 */
export async function crmTools(agent, conversationId = null) {
  const access = await crmAccess(agent, conversationId);
  if (!access) return [];
  const integration = { id: null, name: access.workspace.name, crm: true };
  return TOOLS.filter((t) => offered(t, access)).map((t) => ({
    integration,
    tool: { name: t.name, description: t.description, when: t.when, kind: t.kind === "write" ? "write" : "read", input: modelInput(t.input), ...(t.display ? { display: t.display } : {}) },
  }));
}

/**
 * A refusal from the CRM as codes the agent can explain, with nothing about other customers in it.
 * Anything else that went wrong is logged and reads as "failed": the chat goes on.
 */
function asCodes(e, where) {
  if (!(e instanceof HttpError)) {
    console.error(`CRM tool failed ${where}:`, e.message);
    return { error: "failed" };
  }
  if (e.status === 404) return { error: "not_found" };
  const { code, hard, soft } = e.extra || {};
  if (code === "rules") return { error: "rules", hard: (hard || []).map(forCustomer), soft: (soft || []).map(forCustomer) };
  // Other refusals keep only what a customer may see of them (phone_limit's max, say), and the
  // bridge's own `handoff` (only the team can change this booking now).
  const { code: _, ...params } = forCustomer(e.extra);
  return { error: code || "failed", ...(code ? params : {}), ...(code && e.extra.handoff ? { handoff: true } : {}) };
}

/**
 * Runs a CRM tool the model asked for. Lookups answer now; a change answers with a card the
 * customer confirms. Returns { output (for the model), card? (for the customer) }.
 */
export async function runCrmTool({ agent, conversationId, tool, args = {} }) {
  const def = BY_NAME.get(tool.name);
  const access = def && (await crmAccess(agent, conversationId));
  if (!access || !offered(def, access)) return { output: { error: "unavailable" } };
  if (!checks.get(def.name)(args)) return { output: { error: "bad_input", issues: checks.get(def.name).errors.map((x) => `${x.instancePath || "/"} ${x.message}`).slice(0, 5) } };
  const unreal = unrealDates(args);
  if (unreal.length) return { output: { error: "bad_input", issues: unreal } };
  const lang = langOf(args.language, access.visitor.language);
  try {
    if (!def.customer) return { output: await def.run(access, args, lang) };
    if (!access.conversationId) return { output: { error: "no_conversation" } };
    const link = await currentLink(access);
    if (!ready(link)) return { output: unknown(link) };
    if (def.run) return { output: await def.run(access, args, lang, link) };
    const plan = await def.op.plan(access, link, args, lang);
    if (plan.error) return { output: plan };
    return propose(access, def, plan);
  } catch (e) {
    return { output: asCodes(e, `on conversation ${conversationId}`) };
  }
}

/**
 * Retires the conversation's cards still waiting for the same change: another booking, another
 * order, or another change to the same booking. Their messages show them as cancelled (on
 * Telegram the buttons go), and a press on one is "already handled". Returns how many.
 */
async function retireOlder(access, def, plan) {
  const { rows } = await query(
    `UPDATE pending_actions SET status = 'cancelled', decided_at = now()
      WHERE conversation_id = $1 AND source = 'crm' AND status = 'pending' AND claimed_at IS NULL
        AND (CASE WHEN $3::text IS NULL THEN tool = $2 ELSE args->>'booking' = $3 END)
      RETURNING id`,
    [access.conversationId, def.name, plan.args.booking || null]
  );
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.id);
  await query("UPDATE messages SET card = jsonb_set(card, '{status}', '\"cancelled\"') WHERE conversation_id = $1 AND card->>'action_id' = ANY($2::text[])", [access.conversationId, ids]);
  const conv = (await query("SELECT * FROM conversations WHERE id = $1", [access.conversationId])).rows[0];
  for (const id of ids) await settleCard(conv, id, "cancelled");
  return ids.length;
}

/** Saves a change for the customer's Confirm and gives the card that asks for it. */
async function propose(access, def, plan) {
  const replaced = await retireOlder(access, def, plan);
  const { rows } = await query(
    "INSERT INTO pending_actions (conversation_id, integration_id, source, tool, args, summary) VALUES ($1, NULL, 'crm', $2, $3, $4) RETURNING id",
    [access.conversationId, def.name, plan.args, plan.summary]
  );
  return {
    output: { status: "waiting_for_customer", ...(replaced ? { replaced } : {}) },
    card: { type: "confirm", action_id: rows[0].id, integration_id: null, name: access.workspace.name, ...plan.summary, status: "pending" },
  };
}

/** The change on Confirm: the CRM's rules again, then the write. { status, result } or { status: "failed", refusal }. */
async function carryOut(row, conversationId) {
  const def = BY_NAME.get(row.tool);
  const access = def?.op && (await crmAccess({ id: row.agent_id, workspace_id: row.workspace_id, public_key: row.public_key }, conversationId));
  if (!access || !offered(def, access)) return { status: "failed", refusal: { error: "unavailable" } };
  const link = await currentLink(access);
  if (!ready(link)) return { status: "failed", refusal: unknown(link) };
  try {
    return { status: "done", ...(await def.op.apply(access, link, row.args)) };
  } catch (e) {
    const refusal = asCodes(e, `on Confirm in conversation ${conversationId}`);
    // The time may be gone by now: the agent offers the ones that are free instead. Not when only
    // the price changed (the time is still there), and not when the booking itself can't be
    // changed any more: that is the tool's own answer ({ error, handoff }), never a "rules" one.
    const aboutTime = refusal.error === "rules" && [...refusal.hard, ...refusal.soft].some((r) => r.code !== "price_changed");
    if (!aboutTime || !def.op.alternatives) return { status: "failed", refusal };
    const instead = await def.op.alternatives(access, row.args).catch(() => ({}));
    return { status: "failed", refusal: { ...refusal, ...(instead.times ? { times: instead.times, none: instead.none ?? null } : {}) } };
  }
}

/**
 * The customer pressed Confirm or Cancel on a card. Null when the card is not the CRM's (an
 * integration's card goes its own way). Claimed once, so a double tap can't book twice.
 * Returns the outcome the chat tells the customer about: { status, name, summary, integration_id, result, error }.
 */
export async function decideCrmAction(conversationId, actionId, confirm) {
  if (!/^[0-9a-f-]{36}$/i.test(actionId || "")) return null;
  const { rows } = await query(
    `SELECT a.tool, a.args, a.summary, c.workspace_id, w.name, ag.id AS agent_id, ag.public_key
       FROM pending_actions a JOIN conversations c ON c.id = a.conversation_id JOIN workspaces w ON w.id = c.workspace_id JOIN agents ag ON ag.id = c.agent_id
      WHERE a.id = $1 AND a.conversation_id = $2 AND a.source = 'crm'`,
    [actionId, conversationId]
  );
  const row = rows[0];
  if (!row) return null;
  const claim = await query("UPDATE pending_actions SET claimed_at = now() WHERE id = $1 AND status = 'pending' AND claimed_at IS NULL RETURNING id", [actionId]);
  if (!claim.rowCount) throw new HttpError(409, "This request was already handled.");
  // Claimed, so it must end decided whatever happens: a card left pending could never be pressed again.
  const out = confirm ? await carryOut(row, conversationId).catch((e) => ({ status: "failed", refusal: asCodes(e, `on Confirm in conversation ${conversationId}`) })) : { status: "cancelled" };
  await query("UPDATE pending_actions SET status = $2, result = $3, decided_at = now() WHERE id = $1", [actionId, out.status, out.result ?? out.refusal ?? null]);
  return { status: out.status, name: row.name, summary: row.summary, integration_id: null, result: out.result ?? null, error: out.refusal ? JSON.stringify(out.refusal) : null };
}
