import zlib from "zlib";
import { safeFetch } from "./safeFetch.js";

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
const locs = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<loc>([\\s\\S]*?)</loc>[\\s\\S]*?</${tag}>`, "gi"))].map((m) => decode(m[1].replace(/<!\[CDATA\[|\]\]>/g, "")));

/**
 * Reads a sitemap (or sitemap index, plain or gzipped) and returns its page URLs.
 * Follows nested indexes two levels deep, up to 50 child sitemaps and `maxUrls` pages.
 */
export async function readSitemap(url, { maxUrls = 20000, depth = 0, seen = new Set() } = {}) {
  if (seen.has(url) || seen.size > 50) return [];
  seen.add(url);
  let res;
  try {
    res = await safeFetch(url, { maxBytes: 20 * 1024 * 1024, timeoutMs: 15000 });
  } catch {
    return [];
  }
  if (res.status !== 200) return [];
  let body = res.body;
  if (body[0] === 0x1f && body[1] === 0x8b) {
    try {
      body = zlib.gunzipSync(body);
    } catch {
      return [];
    }
  }
  const xml = body.toString("utf8");
  if (!/<(urlset|sitemapindex)[\s>]/i.test(xml)) return [];
  const out = locs(xml, "url");
  if (depth < 2) {
    for (const child of locs(xml, "sitemap")) {
      if (out.length >= maxUrls) break;
      out.push(...(await readSitemap(child, { maxUrls: maxUrls - out.length, depth: depth + 1, seen })));
    }
  }
  return out.slice(0, maxUrls);
}

/** Groups URLs by their first path segment: [{ prefix: "/uz/", count }], largest first. */
export function sectionsOf(urls) {
  const counts = new Map();
  for (const u of urls) {
    const seg = new URL(u).pathname.split("/").filter(Boolean)[0];
    // Single top-level pages ("/contacts") are grouped as "other"; folders keep their own section.
    const isFolder = seg && urls.filter((x) => new URL(x).pathname.startsWith(`/${seg}/`)).length > 1;
    const key = isFolder ? `/${seg}/` : "/";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([prefix, count]) => ({ prefix, count })).sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix));
}

/** True if the URL's path is inside one of the prefixes. "/" means top-level pages only. */
export function inPaths(url, prefixes) {
  if (!prefixes?.length) return true;
  const path = new URL(url).pathname;
  const depth = path.split("/").filter(Boolean).length;
  return prefixes.some((p) => {
    if (p === "/") return depth <= 1;
    const base = p.replace(/\/+$/, "");
    return path === base || path.startsWith(`${base}/`);
  });
}
