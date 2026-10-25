import crypto from "crypto";
import fs from "fs/promises";
import { query, tx } from "../db.js";
import { ai } from "../ai.js";
import { HttpError } from "../lib/http.js";
import { fileToSections } from "../lib/extract.js";
import { chunkSections, toVector } from "../lib/chunk.js";
import { stripBoilerplate } from "../lib/boilerplate.js";
import { inPaths } from "../lib/sitemap.js";
import { registerJob } from "./jobs.service.js";
import { discoverSite, fetchPages, crawlPages } from "./site.service.js";
import { PLANS } from "./workspaces.service.js";

/** An error whose message is shown on the source as-is and isn't retried. */
const userError = (message) => Object.assign(new Error(message), { user: true });
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

async function insertChunks(c, source, passages, vectors, page = null) {
  if (!passages.length) return;
  await c.query(
    `INSERT INTO chunks (workspace_id, agent_id, source_id, page_id, url, position, heading, content, embedding)
     SELECT $1, $2, $3, $4, $5, t.position, t.heading, t.content, t.embedding::vector
       FROM unnest($6::int[], $7::text[], $8::text[], $9::text[]) AS t(position, heading, content, embedding)`,
    [source.workspace_id, source.agent_id, source.id, page?.id || null, page?.url || null, passages.map((_, i) => i), passages.map((p) => p.heading || null), passages.map((p) => p.content), vectors.map(toVector)]
  );
}

// ───── Files and Q&A: one block of text ─────
async function ingestDocument(source) {
  let sections;
  let pages = null;
  if (source.type === "qa") {
    sections = source.qa.map((p) => ({ heading: `Q: ${p.q}`, text: `Q: ${p.q}\nA: ${p.a}`, whole: true }));
  } else {
    const buffer = await fs.readFile(source.file_path).catch(() => {
      throw userError("The uploaded file is missing. Upload it again.");
    });
    try {
      ({ sections, pages } = await fileToSections(buffer, source.name));
    } catch (e) {
      throw userError(e.message);
    }
  }
  const passages = [...sections.filter((s) => s.whole).map((s) => ({ heading: s.heading, content: s.text })), ...chunkSections(sections.filter((s) => !s.whole))];
  if (!passages.length) throw userError("There's no readable text in this source.");
  const vectors = await ai.embed(passages.map((p) => (p.heading ? `${p.heading}\n` : "") + p.content));
  await tx(async (c) => {
    await c.query("DELETE FROM chunks WHERE source_id = $1", [source.id]);
    await insertChunks(c, source, passages, vectors);
    await c.query("UPDATE sources SET status = 'ready', error = NULL, pages = $2, chunk_count = $3, preview = $4, progress = NULL, updated_at = now() WHERE id = $1", [
      source.id,
      pages,
      passages.length,
      sections.map((s) => s.text).join("\n\n").slice(0, 1200),
    ]);
  });
}

// ───── Websites: one row per page, re-embedding only what changed ─────
async function ingestWebsite(source, heartbeat) {
  const plan = (await query("SELECT plan FROM workspaces WHERE id = $1", [source.workspace_id])).rows[0]?.plan || "growth";
  const limit = PLANS[plan].pages;
  const mode = source.mode || (source.include_linked ? "site" : "page");
  const progress = async (done, total) => {
    await query("UPDATE sources SET progress = $2 WHERE id = $1", [source.id, { done, total }]);
    heartbeat && (await heartbeat());
  };
  const start = new URL(source.url);

  let fetched;
  let discovery = "page";
  let overLimit = 0;
  if (mode === "page") {
    fetched = await fetchPages([source.url], progress);
  } else {
    const site = await discoverSite(source.url);
    if (!site.allowed(site.start)) throw userError("This site's robots.txt asks crawlers not to read that page.");
    const inScope = site.pages.filter((u) => inPaths(u, source.include_paths));
    if (inScope.length) {
      discovery = "sitemap";
      overLimit = Math.max(0, inScope.length - limit);
      fetched = await fetchPages(inScope.slice(0, limit), progress);
    } else {
      discovery = "links";
      const crawled = await crawlPages(site.start, source.include_paths, limit, site.allowed, progress);
      fetched = crawled.pages;
      overLimit = crawled.more;
    }
  }

  const ok = stripBoilerplate(fetched.filter((p) => p.ok)).filter((p) => p.text.length >= 20);
  const failed = fetched.filter((p) => !p.ok);
  if (!ok.length) {
    if (mode === "page" || fetched.length === 1) {
      throw userError(`We couldn't read ${start.host}${start.pathname}. ${failed[0]?.error || "It has no readable text."} Check that it's published, then retry.`);
    }
    throw userError(`None of the ${fetched.length} pages could be read. ${failed[0]?.error || ""}`.trim());
  }

  // Compare with what we already have: unchanged pages keep their passages and embeddings.
  const existing = new Map((await query("SELECT id, url, content_hash FROM source_pages WHERE source_id = $1", [source.id])).rows.map((r) => [r.url, r]));
  const withHash = ok.map((p) => ({ ...p, hash: sha(`${p.title}\n${p.text}`) }));
  const changed = withHash.filter((p) => existing.get(p.url)?.content_hash !== p.hash);
  const passagesByPage = changed.map((p) => chunkSections([{ heading: p.title, text: p.text }]));
  const flat = passagesByPage.flat();
  const vectors = flat.length ? await ai.embed(flat.map((p) => `${p.heading}\n${p.content}`)) : [];

  await tx(async (c) => {
    await c.query("DELETE FROM chunks WHERE source_id = $1 AND page_id IS NULL", [source.id]); // from before page tracking
    let v = 0;
    for (let i = 0; i < changed.length; i++) {
      const p = changed[i];
      const passages = passagesByPage[i];
      const { rows } = await c.query(
        `INSERT INTO source_pages (source_id, workspace_id, url, title, status, error, content_hash, chars, chunk_count, fetched_at)
         VALUES ($1, $2, $3, $4, 'ready', NULL, $5, $6, $7, now())
         ON CONFLICT (source_id, url) DO UPDATE SET title = EXCLUDED.title, status = 'ready', error = NULL, content_hash = EXCLUDED.content_hash,
           chars = EXCLUDED.chars, chunk_count = EXCLUDED.chunk_count, fetched_at = now()
         RETURNING id, url`,
        [source.id, source.workspace_id, p.url, p.title, p.hash, p.text.length, passages.length]
      );
      await c.query("DELETE FROM chunks WHERE page_id = $1", [rows[0].id]);
      await insertChunks(c, source, passages, vectors.slice(v, v + passages.length), rows[0]);
      v += passages.length;
    }
    const unchanged = withHash.filter((p) => !changed.includes(p)).map((p) => p.url);
    if (unchanged.length) await c.query("UPDATE source_pages SET fetched_at = now() WHERE source_id = $1 AND url = ANY($2)", [source.id, unchanged]);
    for (const f of failed) {
      await c.query(
        `INSERT INTO source_pages (source_id, workspace_id, url, status, error, chunk_count) VALUES ($1, $2, $3, 'error', $4, 0)
         ON CONFLICT (source_id, url) DO UPDATE SET status = 'error', error = EXCLUDED.error, chunk_count = 0, fetched_at = now()`,
        [source.id, source.workspace_id, f.url, f.error]
      );
      await c.query("DELETE FROM chunks WHERE source_id = $1 AND url = $2", [source.id, f.url]);
    }
    // Pages that left the site (or the chosen sections) are removed with their passages.
    await c.query("DELETE FROM source_pages WHERE source_id = $1 AND NOT (url = ANY($2))", [source.id, fetched.map((p) => p.url)]);
    const totals = (await c.query("SELECT count(*)::int AS n FROM chunks WHERE source_id = $1", [source.id])).rows[0].n;
    const notes = [failed.length && `${plural(failed.length, "page")} couldn't be read`, overLimit && `${plural(overLimit, "more page")} skipped by your plan's limit of ${limit}`].filter(Boolean);
    await c.query(
      `UPDATE sources SET status = 'ready', error = $2, pages = $3, pages_failed = $4, pages_over_limit = $5, chunk_count = $6, preview = $7,
              discovery = $8, progress = NULL, syncing = false, last_synced_at = now(),
              next_sync_at = CASE WHEN sync_interval_days > 0 THEN now() + make_interval(days => sync_interval_days) END, updated_at = now()
        WHERE id = $1`,
      [source.id, notes.length ? `${notes.join("; ")}.` : null, ok.length, failed.length, overLimit, totals, ok[0].text.slice(0, 1200), discovery]
    );
  });
  return { pages: ok.length, changed: changed.length, failed: failed.length };
}

/** Processes a source. `final` = no more retries; `heartbeat` keeps a long job from looking stuck. */
export async function ingestSource(sourceId, { final = true, heartbeat } = {}) {
  const { rows } = await query("SELECT * FROM sources WHERE id = $1", [sourceId]);
  const source = rows[0];
  if (!source) return;
  try {
    return source.type === "website" ? await ingestWebsite(source, heartbeat) : await ingestDocument(source);
  } catch (e) {
    // Our own HttpErrors (e.g. no API key configured) won't be fixed by retrying.
    if (e instanceof HttpError) e.user = true;
    if (!e.user && !final) throw e; // a passing problem (network, OpenAI): let the job retry
    const message = e.user ? e.message : "Processing failed because of a temporary problem on our side. Retry in a few minutes.";
    if (!e.user) console.error(`Ingest of source ${source.id} failed:`, e.message);
    // A failed re-sync of a working source keeps the pages it already has.
    const keep = source.status === "ready" && source.chunk_count > 0;
    await query(
      `UPDATE sources SET status = $2, error = $3, progress = NULL, syncing = false,
              next_sync_at = CASE WHEN sync_interval_days > 0 THEN now() + make_interval(days => sync_interval_days) END, updated_at = now()
        WHERE id = $1`,
      [source.id, keep ? "ready" : "error", keep ? `Last sync failed: ${message}` : message]
    );
  }
}

registerJob("ingest_source", ({ source_id }, { final, heartbeat }) => ingestSource(source_id, { final, heartbeat }));
