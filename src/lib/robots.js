import { safeFetch } from "./safeFetch.js";

/** Reads robots.txt rules for "*" and ReplybekBot. Returns allowed(url) → boolean, with `.sitemaps` (listed sitemap URLs). */
export async function robotsFor(origin) {
  let text = "";
  try {
    const res = await safeFetch(new URL("/robots.txt", origin).href, { maxBytes: 200 * 1024, timeoutMs: 5000 });
    if (res.status === 200) text = res.body.toString("utf8");
  } catch {
    // No robots.txt (or unreachable): everything is allowed.
  }
  const rules = [];
  const sitemaps = [];
  let applies = false;
  let sawRule = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, field, value] = [m[0], m[1].toLowerCase(), m[2].trim()];
    if (field === "sitemap") {
      if (/^https?:\/\//i.test(value)) sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (sawRule) applies = false;
      sawRule = false;
      if (value === "*" || /replybekbot/i.test(value)) applies = true;
    } else if (field === "disallow" || field === "allow") {
      sawRule = true;
      if (applies && value) rules.push({ allow: field === "allow", path: value });
    }
  }
  const allowed = (url) => {
    const path = new URL(url).pathname;
    // The longest matching rule wins; Allow wins ties.
    let best = null;
    for (const r of rules) if (path.startsWith(r.path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
    return !best || best.allow;
  };
  allowed.sitemaps = sitemaps;
  return allowed;
}
