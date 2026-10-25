import fs from "fs/promises";
import path from "path";
import { query, tx } from "../db.js";
import { notFound, HttpError } from "../lib/http.js";
import { normalizeUrl, assertPublicHost } from "../lib/safeFetch.js";
import { checkFileSignature } from "../lib/extract.js";
import { enqueue } from "./jobs.service.js";
import { previewSite, defaultPaths } from "./site.service.js";
import { PLANS } from "./workspaces.service.js";
import { logActivity } from "./activity.service.js";

const PUBLIC = "id, agent_id, type, name, url, include_linked, mode, include_paths, discovery, mime, bytes, qa, status, error, pages, pages_failed, pages_over_limit, progress, syncing, sync_interval_days, last_synced_at, next_sync_at, chunk_count, created_at, updated_at";
const uploadDir = () => path.resolve(process.env.UPLOAD_DIR || "./data/uploads");

export async function listSources(workspaceId, agentId) {
  const { rows } = await query(`SELECT ${PUBLIC} FROM sources WHERE workspace_id = $1 AND agent_id = $2 ORDER BY created_at`, [workspaceId, agentId]);
  return rows;
}

/** Sources across all agents, optionally only one status (e.g. failed imports for the Overview). */
export async function listWorkspaceSources(workspaceId, status) {
  const { rows } = await query(
    `SELECT ${PUBLIC} FROM sources WHERE workspace_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY updated_at DESC LIMIT 100`,
    [workspaceId, status || null]
  );
  return rows;
}

export async function getSource(workspaceId, sourceId) {
  if (!/^[0-9a-f-]{36}$/i.test(sourceId)) throw notFound("Source not found");
  const { rows } = await query(`SELECT ${PUBLIC}, preview FROM sources WHERE id = $1 AND workspace_id = $2`, [sourceId, workspaceId]);
  if (!rows[0]) throw notFound("Source not found");
  const passages = await query("SELECT heading, content FROM chunks WHERE source_id = $1 ORDER BY position LIMIT 5", [sourceId]);
  return { ...rows[0], passages: passages.rows };
}

async function create(agent, user, fields) {
  return tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO sources (workspace_id, agent_id, type, name, url, include_linked, mode, include_paths, sync_interval_days, mime, bytes, qa, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING ${PUBLIC}`,
      [
        agent.workspace_id, agent.id, fields.type, fields.name, fields.url || null, fields.include_linked || false, fields.mode || null,
        fields.include_paths || [], fields.sync_interval_days || 0, fields.mime || null, fields.bytes || null, fields.qa ? JSON.stringify(fields.qa) : null, user.id,
      ]
    );
    await enqueue("ingest_source", { source_id: rows[0].id }, c);
    return rows[0];
  });
}

const planOf = async (workspaceId) => (await query("SELECT plan FROM workspaces WHERE id = $1", [workspaceId])).rows[0]?.plan || "growth";

/** What adding this site would import: sitemap sections and page counts, before anything is stored. */
export async function previewWebsite(agent, url) {
  return previewSite(url, PLANS[await planOf(agent.workspace_id)].pages);
}

/**
 * mode "page": just this page. mode "site": the whole site (sitemap first, else following links),
 * limited to `include_paths` (defaults to the start URL's folder). Sites re-sync weekly by default.
 */
export async function addWebsite(agent, user, { url, include_linked, mode, include_paths, sync_interval_days }) {
  const u = normalizeUrl(url);
  await assertPublicHost(u.hostname);
  const m = mode || (include_linked ? "site" : "page");
  const paths = m === "site" ? include_paths ?? defaultPaths(u.href) : [];
  const scope = m === "site" ? (paths.length ? ` (${paths.join(", ")})` : "") : u.pathname === "/" ? "" : u.pathname;
  const source = await create(agent, user, {
    type: "website",
    name: m === "site" ? `${u.host}${scope}` : u.host + scope,
    url: u.href,
    include_linked: m === "site",
    mode: m,
    include_paths: paths,
    sync_interval_days: sync_interval_days ?? (m === "site" ? 7 : 0),
  });
  await logActivity(agent.workspace_id, user.id, "{actor} added “{name}”", { actor: user.name, name: source.name }, agent.name);
  return source;
}

export async function addQA(agent, user, { question, answer, unanswered_id }) {
  const source = await create(agent, user, { type: "qa", name: question.length > 80 ? question.slice(0, 77) + "…" : question, qa: [{ q: question, a: answer }] });
  if (unanswered_id) await query("UPDATE unanswered SET answered_at = now() WHERE id = $1 AND agent_id = $2", [unanswered_id, agent.id]);
  await logActivity(agent.workspace_id, user.id, "{actor} added a Q&A answer", { actor: user.name }, question.slice(0, 80));
  return source;
}

export async function addFile(agent, user, file) {
  if (!file) throw new HttpError(400, "Choose a file to upload.");
  const name = path.basename(file.originalname).replace(/[^\w.\- ]+/g, "_").slice(0, 120);
  if (!/\.(pdf|docx|txt|md|csv)$/i.test(name)) throw new HttpError(415, "Upload a PDF, DOCX, TXT, MD or CSV file.");
  checkFileSignature(file.buffer, name);
  const source = await create(agent, user, { type: "file", name, mime: file.mimetype, bytes: file.size });
  const dir = path.join(uploadDir(), agent.workspace_id);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${source.id}${path.extname(name).toLowerCase()}`);
  await fs.writeFile(filePath, file.buffer);
  await query("UPDATE sources SET file_path = $2 WHERE id = $1", [source.id, filePath]);
  await logActivity(agent.workspace_id, user.id, "{actor} uploaded “{name}”", { actor: user.name, name }, agent.name);
  return source;
}

/** Pages of a website source, failed ones first. */
export async function listPages(workspaceId, sourceId, { status, q } = {}) {
  await getSource(workspaceId, sourceId);
  const { rows } = await query(
    `SELECT id, url, title, status, error, chars, chunk_count, fetched_at FROM source_pages
      WHERE source_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR lower(url || ' ' || coalesce(title, '')) LIKE $3)
      ORDER BY status = 'ready', url LIMIT 1000`,
    [sourceId, status || null, q ? `%${q.toLowerCase()}%` : null]
  );
  return rows;
}

/** Fetches the website again now. The source keeps answering from its current pages meanwhile. */
export async function resyncSource(workspaceId, sourceId) {
  const source = await getSource(workspaceId, sourceId);
  if (source.type !== "website") throw new HttpError(400, "Only websites can be re-synced.");
  if (source.status === "processing" || source.syncing) return source;
  if (source.status === "error") return retrySource(workspaceId, sourceId);
  await tx(async (c) => {
    await c.query("UPDATE sources SET syncing = true WHERE id = $1", [sourceId]);
    await enqueue("ingest_source", { source_id: sourceId }, c);
  });
  return { ...source, syncing: true };
}

export async function updateSource(workspaceId, sourceId, { sync_interval_days }) {
  const source = await getSource(workspaceId, sourceId);
  if (sync_interval_days !== undefined) {
    if (source.type !== "website") throw new HttpError(400, "Only websites re-sync automatically.");
    await query(
      `UPDATE sources SET sync_interval_days = $2,
              next_sync_at = CASE WHEN $2 > 0 THEN COALESCE(last_synced_at, now()) + make_interval(days => $2) END WHERE id = $1`,
      [sourceId, sync_interval_days]
    );
  }
  return getSource(workspaceId, sourceId);
}

export async function retrySource(workspaceId, sourceId) {
  const source = await getSource(workspaceId, sourceId);
  await tx(async (c) => {
    await c.query("UPDATE sources SET status = 'processing', error = NULL, updated_at = now() WHERE id = $1", [sourceId]);
    await enqueue("ingest_source", { source_id: sourceId }, c);
  });
  return { ...source, status: "processing", error: null };
}

export async function removeSource(workspaceId, sourceId, user) {
  const { rows } = await query("DELETE FROM sources WHERE id = $1 AND workspace_id = $2 RETURNING name, file_path", [sourceId, workspaceId]);
  if (!rows[0]) throw notFound("Source not found");
  if (rows[0].file_path) await fs.rm(rows[0].file_path, { force: true });
  await logActivity(workspaceId, user.id, "{actor} removed “{name}”", { actor: user.name, name: rows[0].name });
}

export async function listUnanswered(workspaceId, agentId) {
  const { rows } = await query(
    `SELECT id, agent_id, question, times, last_asked_at, answered_at FROM unanswered
      WHERE workspace_id = $1 AND dismissed_at IS NULL AND ($2::uuid IS NULL OR agent_id = $2) ORDER BY answered_at IS NOT NULL, times DESC, last_asked_at DESC LIMIT 50`,
    [workspaceId, agentId || null]
  );
  return rows;
}

/** Hides an unanswered question that isn't relevant. Asking it again won't bring it back. */
export async function dismissUnanswered(workspaceId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Question not found");
  const { rowCount } = await query("UPDATE unanswered SET dismissed_at = now() WHERE id = $1 AND workspace_id = $2 AND dismissed_at IS NULL", [id, workspaceId]);
  if (!rowCount) throw notFound("Question not found");
}
