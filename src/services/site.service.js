import { safeFetch, normalizeUrl, assertPublicHost } from "../lib/safeFetch.js";
import { robotsFor } from "../lib/robots.js";
import { readSitemap, sectionsOf, inPaths } from "../lib/sitemap.js";
import { htmlToText } from "../lib/extract.js";

const SKIP_EXT = /\.(png|jpe?g|gif|webp|svg|ico|pdf|zip|mp4|mp3|css|js|xml|json|woff2?|txt)$/i;
const sameSite = (a, b) => a.replace(/^www\./, "") === b.replace(/^www\./, "");
const CONCURRENCY = 3; // be polite to customers' servers

/**
 * The default scope for a start URL: its first folder ("/uz/" for /uz/ or /uz/some-page/), or the
 * whole site for the home page or a single top-level page like /help or /demo.html.
 */
export function defaultPaths(url) {
  const path = normalizeUrl(url).pathname;
  const segs = path.split("/").filter(Boolean);
  if (!segs.length || (segs.length === 1 && !path.endsWith("/"))) return [];
  return [`/${segs[0]}/`];
}

/** Finds the site's sitemap pages (robots.txt "Sitemap:" lines, then /sitemap.xml). */
export async function discoverSite(input) {
  const start = normalizeUrl(input);
  await assertPublicHost(start.hostname);
  const allowed = await robotsFor(start.origin);
  const candidates = [...new Set([...allowed.sitemaps, `${start.origin}/sitemap.xml`, `${start.origin}/sitemap_index.xml`])];
  let urls = [];
  let sitemapUrl = null;
  for (const sm of candidates) {
    urls = await readSitemap(sm);
    if (urls.length) {
      sitemapUrl = sm;
      break;
    }
  }
  const pages = [];
  let blocked = 0;
  for (const raw of new Set(urls)) {
    let u;
    try {
      u = normalizeUrl(raw);
    } catch {
      continue;
    }
    if (!sameSite(u.hostname, start.hostname) || SKIP_EXT.test(u.pathname)) continue;
    if (!allowed(u.href)) {
      blocked++;
      continue;
    }
    pages.push(u.href);
  }
  return { start: start.href, sitemapUrl, pages, blocked, allowed };
}

/** What the "Add website" dialog shows before importing. */
export async function previewSite(input, pageLimit) {
  const site = await discoverSite(input);
  return {
    url: site.start,
    host: new URL(site.start).host,
    sitemap: Boolean(site.sitemapUrl),
    total: site.pages.length,
    blocked_by_robots: site.blocked,
    sections: sectionsOf(site.pages),
    suggested_paths: site.pages.length ? defaultPaths(site.start).filter((p) => site.pages.some((u) => inPaths(u, [p]))) : defaultPaths(site.start),
    page_limit: pageLimit,
  };
}

/** Fetches one page and extracts its main text. Never throws: failures come back as { ok: false }. */
async function fetchPage(url, timeoutMs = 10000) {
  try {
    // Pages heavy with inline CSS or scripts are read up to 10 MB rather than skipped.
    const res = await safeFetch(url, { timeoutMs, maxBytes: 10 * 1024 * 1024, truncate: true });
    if (res.status >= 500 || res.status === 429) return { url, ok: false, retry: true, error: `The page returned “${res.status}”.` };
    if (res.status >= 400) return { url, ok: false, error: `The page returned “${res.status}”.` };
    if (!/text\/html|text\/plain|application\/xhtml/.test(res.type)) return { url, ok: false, error: "Not a web page." };
    const html = res.body.toString("utf8");
    const { title, text, links } = res.type.includes("plain") ? { title: url, text: html, links: [] } : htmlToText(html, res.url);
    if (text.length < 40) return { url, ok: false, error: "No readable text on this page." };
    return { url, ok: true, title, text, links };
  } catch (e) {
    const timedOut = /abort|timeout/i.test(e.name + " " + e.message);
    return { url, ok: false, retry: !e.status, error: timedOut ? "The page took too long to respond." : e.message || "Couldn't reach the page." };
  }
}

/** Fetches many pages, a few at a time. `onProgress(done, total)` is called as they finish. */
export async function fetchPages(urls, onProgress) {
  const out = new Array(urls.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < urls.length) {
      const i = next++;
      out[i] = await fetchPage(urls[i]);
      done++;
      if (onProgress && (done % 5 === 0 || done === urls.length)) await onProgress(done, urls.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  // Slow or busy servers: retry pages that timed out or answered 5xx/429 once, one at a time, with more patience.
  for (let i = 0; i < out.length; i++) {
    if (out[i].retry) {
      await new Promise((r) => setTimeout(r, process.env.NODE_ENV === "test" ? 10 : 1000));
      out[i] = await fetchPage(urls[i], 25000);
    }
  }
  return out;
}

/** Without a sitemap: follows same-site links breadth-first from the start page, inside `paths`. */
export async function crawlPages(start, paths, limit, allowed, onProgress) {
  const queue = [start];
  const seen = new Set(queue);
  const pages = [];
  while (queue.length && pages.length < limit) {
    const batch = queue.splice(0, Math.min(CONCURRENCY, limit - pages.length));
    for (const page of await fetchPages(batch)) {
      pages.push(page);
      for (const link of page.links || []) {
        const u = new URL(link);
        if (!seen.has(link) && sameSite(u.hostname, new URL(start).hostname) && !SKIP_EXT.test(u.pathname) && inPaths(link, paths) && allowed(link)) {
          seen.add(link);
          queue.push(link);
        }
      }
    }
    if (onProgress) await onProgress(pages.length, Math.min(limit, pages.length + queue.length));
  }
  return { pages, more: queue.length };
}
