// Branches: the places a business works from. Every workspace has a default one from the start
// (see db.js); rows that belong to a place carry its id.

const BRANCH = `id, name, address, is_default AS "default"`;

/** The workspace's branches, the default one first. */
export async function listBranches(q, cfg) {
  return (await q(`SELECT ${BRANCH} FROM crm_branches WHERE workspace_id = $1 ORDER BY is_default DESC, created_at, id`, [cfg.workspaceId])).rows;
}

/** One branch of the workspace, or null. */
export async function branchOf(q, cfg, id) {
  return (await q(`SELECT ${BRANCH} FROM crm_branches WHERE workspace_id = $1 AND id = $2`, [cfg.workspaceId, id])).rows[0] || null;
}
