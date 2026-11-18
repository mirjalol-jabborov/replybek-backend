// Branches: the places a business works from. Every workspace has a default one from the start
// (see db.js); rows that belong to a place carry its id.

const BRANCH = `id, name, address, is_default AS "default"`;

/** One branch of the workspace, or null. */
export async function branchOf(q, cfg, id) {
  return (await q(`SELECT ${BRANCH} FROM crm_branches WHERE workspace_id = $1 AND id = $2`, [cfg.workspaceId, id])).rows[0] || null;
}
