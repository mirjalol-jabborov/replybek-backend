import { query } from "../../core/db.js";
import { HttpError, notFound } from "../../core/http.js";
import { sameAction } from "./definitions.js";
import { safeOrigin } from "./in-page.js";
import { connection } from "./connections.js";
import { callTool } from "./tools.js";
import { resumeProcedure } from "./procedures.js";

/** The integration mode behind a pending action ('server' | 'in_page'), or null. */
export async function actionIntegrationMode(conversationId, actionId) {
  if (!/^[0-9a-f-]{36}$/i.test(actionId || "")) return null;
  const { rows } = await query("SELECT i.mode FROM pending_actions a JOIN integrations i ON i.id = a.integration_id WHERE a.id = $1 AND a.conversation_id = $2", [actionId, conversationId]);
  return rows[0]?.mode || null;
}

/** Atomically claim a confirmation so double-clicks cannot repeat a business write. */
export async function decideAction(conversationId, actionId, confirm, inpageOrigin = null) {
  if (!/^[0-9a-f-]{36}$/i.test(actionId || "")) throw notFound("Action not found");
  const { rows } = await query("SELECT a.*, i.*, a.id AS action_id, a.status AS action_status FROM pending_actions a JOIN integrations i ON i.id = a.integration_id WHERE a.id = $1 AND a.conversation_id = $2", [actionId, conversationId]);
  const row = rows[0]; if (!row) throw notFound("Action not found");
  if (confirm && row.mode === "in_page" && safeOrigin(row.base_url) !== inpageOrigin) throw new HttpError(403, "Confirm this action inside the connected system.");
  const claim = await query("UPDATE pending_actions SET claimed_at = now() WHERE id = $1 AND conversation_id = $2 AND status = 'pending' AND claimed_at IS NULL RETURNING id", [actionId, conversationId]);
  if (!claim.rowCount) throw new HttpError(409, "This request was already handled.");
  const integration = { ...row, id: row.integration_id };
  let out = { error: "failed", message: "This action is no longer available." };
  if (confirm && row.enabled) {
    const current = (row.tools || []).find(t => t.name === row.tool && t.kind === "write");
    const tool = row.tool_snapshot || current;
    // A changed/deleted action cannot silently change what the customer approved.
    if (current && tool && sameAction(current, tool) && (row.integration_revision == null || row.integration_revision === row.config_revision)) {
      try { out = await callTool(integration, tool, row.args, await connection(row.integration_id, conversationId), conversationId); }
      catch { out = { error: "failed", message: "The request did not complete. Verify the result in the connected system before trying again." }; }
    }
  }
  const status = !confirm ? "cancelled" : out.ok ? "done" : "failed";
  await query("UPDATE pending_actions SET status = $2, result = $3, decided_at = now() WHERE id = $1", [actionId, status, out]);
  const outcome = { status, name: row.name, summary: row.summary, integration_id: row.integration_id, result: out.ok ? out.result : null, error: confirm && !out.ok ? out.message : null };
  if (row.procedure_run_id) outcome.continuation = await resumeProcedure(row.procedure_run_id, outcome, inpageOrigin);
  return outcome;
}
