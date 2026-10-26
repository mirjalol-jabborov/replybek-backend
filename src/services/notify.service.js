// Tells the team by email that a customer is waiting for a person, when nobody has the dashboard
// open to see it (the live-update streams say whether anyone does). At most once an hour per conversation.
import { query } from "../db.js";
import { watching } from "./events.service.js";
import { sendWaiting, sendAllowanceUsed } from "./emails.service.js";
import { PLANS, allowanceResets } from "./workspaces.service.js";

export async function notifyWaiting(conv) {
  if (watching(conv.workspace_id)) return { sent: 0 };
  const claimed = await query(
    "UPDATE conversations SET notified_at = now() WHERE id = $1 AND (notified_at IS NULL OR notified_at < now() - interval '1 hour') RETURNING visitor",
    [conv.id]
  );
  if (!claimed.rows[0]) return { sent: 0 };
  const { rows: team } = await query(
    "SELECT u.email, u.lang, w.name AS workspace FROM memberships m JOIN users u ON u.id = m.user_id JOIN workspaces w ON w.id = m.workspace_id WHERE m.workspace_id = $1",
    [conv.workspace_id]
  );
  const last = await query("SELECT body FROM messages WHERE conversation_id = $1 AND role = 'visitor' AND body <> '' ORDER BY seq DESC LIMIT 1", [conv.id]);
  const visitorName = claimed.rows[0].visitor?.name;
  await Promise.all(
    team.map((m) =>
      sendWaiting({
        to: m.email,
        lang: m.lang,
        visitor: visitorName || { uz: "Mijoz", ru: "Клиент" }[m.lang] || "A customer",
        workspace: m.workspace,
        message: last.rows[0]?.body || "…",
        conversationId: conv.id,
      })
    )
  );
  return { sent: team.length };
}

/**
 * Emails the workspace's owners and admins once a month, when its AI messages reach the plan's limit
 * (from then on the widget passes chats to the team instead of answering).
 */
export async function notifyAllowanceUsed(workspaceId) {
  const { rows } = await query("SELECT plan FROM workspaces WHERE id = $1", [workspaceId]);
  const limit = PLANS[rows[0]?.plan]?.messages;
  if (!limit) return { sent: 0 };
  const claimed = await query(
    "UPDATE usage SET limit_emailed_at = now() WHERE workspace_id = $1 AND period = $2 AND messages >= $3 AND limit_emailed_at IS NULL RETURNING 1",
    [workspaceId, new Date().toISOString().slice(0, 7), limit]
  );
  if (!claimed.rowCount) return { sent: 0 };
  const { rows: admins } = await query(
    "SELECT u.email, u.lang, w.name AS workspace FROM memberships m JOIN users u ON u.id = m.user_id JOIN workspaces w ON w.id = m.workspace_id WHERE m.workspace_id = $1 AND m.role IN ('owner', 'admin')",
    [workspaceId]
  );
  await Promise.all(admins.map((m) => sendAllowanceUsed({ to: m.email, lang: m.lang, workspace: m.workspace, limit, resetsAt: allowanceResets() })));
  return { sent: admins.length };
}
