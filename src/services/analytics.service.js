import { query } from "../db.js";

/**
 * Conversation volume for the last `days` days in the workspace's time zone. A conversation
 * counts once it has a visitor message; it's "escalated" if it was ever handed to a person.
 */
export async function analytics(workspace, { days = 30, agentId = null } = {}) {
  const tz = workspace.timezone || "UTC";
  const params = [workspace.id, days, tz, agentId];
  const scope = "c.workspace_id = $1 AND c.subject IS NOT NULL AND ($4::uuid IS NULL OR c.agent_id = $4)";
  const [series, totals, previous, unanswered] = await Promise.all([
    query(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day,
              count(c.id)::int AS total,
              count(c.id) FILTER (WHERE c.escalated_at IS NOT NULL)::int AS escalated
         FROM generate_series((now() AT TIME ZONE $3)::date - ($2::int - 1), (now() AT TIME ZONE $3)::date, interval '1 day') AS d
         LEFT JOIN conversations c ON ${scope} AND (c.created_at AT TIME ZONE $3)::date = d::date
        GROUP BY d ORDER BY d`,
      params
    ),
    query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE c.escalated_at IS NOT NULL)::int AS escalated,
              count(*) FILTER (WHERE c.status = 'resolved')::int AS resolved
         FROM conversations c WHERE ${scope} AND c.created_at > now() - make_interval(days => $2) AND $3::text IS NOT NULL`,
      params
    ),
    query(
      `SELECT count(*)::int AS total FROM conversations c
        WHERE ${scope} AND c.created_at <= now() - make_interval(days => $2) AND c.created_at > now() - make_interval(days => $2 * 2) AND $3::text IS NOT NULL`,
      params
    ),
    query("SELECT count(*)::int AS n FROM unanswered WHERE workspace_id = $1 AND answered_at IS NULL AND dismissed_at IS NULL AND ($2::uuid IS NULL OR agent_id = $2)", [workspace.id, agentId]),
  ]);
  const t = totals.rows[0];
  return {
    days,
    total: t.total,
    escalated: t.escalated,
    by_ai: t.total - t.escalated,
    previous_total: previous.rows[0].total,
    open_unanswered: unanswered.rows[0].n,
    series: series.rows.map((r) => ({ day: r.day, total: r.total, escalated: r.escalated, by_ai: r.total - r.escalated })),
  };
}
