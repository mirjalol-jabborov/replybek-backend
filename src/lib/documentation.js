import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { safeFetch } from "./safeFetch.js";
import { htmlToText } from "./extract.js";
import { HttpError } from "./http.js";

const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const description = (value) => {
  const text = typeof value === "string" ? value : value?.content || "";
  return /<\/?(?:p|div|table|h[1-6]|ul|br)\b/i.test(text) ? htmlToText(text, "https://documentation.invalid/").text : text;
};

/** Read data only: never evaluate collection scripts, run requests, or import auth values. */
export function postmanDocumentation(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const collection = parsed?.collection || parsed;
  if (!collection?.info || !Array.isArray(collection.item)) return null;
  const endpoints = [];
  function walk(items, parents = [], inheritedAuth = collection.auth?.type, depth = 0, context = []) {
    if (depth > 20) throw new HttpError(422, "This collection has too many nested folders.");
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const auth = item.auth?.type || inheritedAuth;
      if (item.request && typeof item.request === "object") {
        if (endpoints.length >= 500) throw new HttpError(413, "Import a collection with at most 500 endpoints.");
        const req = item.request;
        const rawUrl = typeof req.url === "string" ? req.url : req.url?.raw || "";
        let url = rawUrl,
          path = "",
          base = "";
        try {
          const u = new URL(rawUrl);
          u.username = "";
          u.password = "";
          if (/^https?:$/.test(u.protocol)) {
            base = u.origin;
            path = u.pathname;
            // Query values may contain example tokens or account identifiers. Keep names only.
            url = base + path;
          }
        } catch {
          path = rawUrl.replace(/^\{\{[^}]+\}\}/, "").split("?")[0];
          if (!path.startsWith("/")) path = "";
          url = path;
        }
        const method = String(req.method || "GET").toUpperCase();
        const id = createHash("sha256")
          .update(JSON.stringify([parents, item.name, method, rawUrl, endpoints.length]))
          .digest("hex")
          .slice(0, 24);
        endpoints.push({
          id,
          name: String(item.name || method + " " + path).slice(0, 200),
          group: parents.join(" / ").slice(0, 500),
          method,
          path,
          base,
          url,
          supported: methods.has(method) && Boolean(path),
          auth_type: req.auth?.type || auth || "unknown",
          description: [...context, description(req.description || item.description), ...(item.response || []).map(r => `Response example (${r.code || ""}): ${r.body || ""}`)].join("\n\n"),
          headers: (Array.isArray(req.header) ? req.header : [])
            .filter((h) => !h.disabled)
            .map((h) => String(h.key || ""))
            .filter(Boolean),
          query:
            [req.url?.query, req.urlObject?.query]
              .find(Array.isArray)
              ?.filter((q) => !q.disabled)
              .map((q) => String(q.key || ""))
              .filter(Boolean) || [],
          body: req.body?.mode === "raw" ? String(req.body.raw || "") : "",
          body_mode: req.body?.mode || "none",
        });
      }
      if (Array.isArray(item.item)) walk(item.item, [...parents, String(item.name || "Folder")], auth, depth + 1, [...context, description(item.description)].filter(Boolean));
    }
  }
  walk(collection.item);
  return { name: String(collection.info.name || "Postman collection").slice(0, 200), overview: description(collection.info.description), endpoints };
}

export function collectionCatalog(collection) {
  return {
    name: collection.name,
    count: collection.endpoints.length,
    max_selection: 500,
    format: collection.format || "postman",
    coverage: collection.coverage || { read: 1, failed: [], limited: false },
    endpoints: collection.endpoints.map(({ id, name, group, method, path, supported, auth_type }) => ({ id, name, group, method, path, supported, auth_type })),
  };
}

/** A Postman documentation shell advertises its collection as a same-origin prefetch. */
export async function discoverPostman(html, pageUrl) {
  const $ = cheerio.load(html);
  if (!/postman/i.test($("meta[name=generator]").attr("content") || "")) return null;
  const candidates = $("link[rel=prefetch][href]")
    .toArray()
    .map((el) => $(el).attr("href"));
  for (const href of candidates) {
    let url;
    try {
      url = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (url.origin !== new URL(pageUrl).origin || !/^\/api\/collections\//.test(url.pathname)) continue;
    const page = await safeFetch(url.href, { maxBytes: 2 * 1024 * 1024 });
    if (page.status < 200 || page.status >= 300)
      throw new HttpError(422, "The documentation collection could not be read. Export and upload its Postman JSON file.");
    const collection = postmanDocumentation(page.body.toString("utf8"));
    if (collection) return collection;
  }
  return null;
}

export function selectedDocumentation(collection, ids) {
  if (!ids.length || ids.length > 10 || new Set(ids).size !== ids.length) throw new HttpError(400, "Select between 1 and 10 distinct endpoints.");
  const selected = ids.map((id) => collection.endpoints.find((e) => e.id === id));
  if (selected.some((e) => !e?.supported)) throw new HttpError(400, "The selected endpoints are no longer available. Read the documentation again.");
  const warnings = [];
  const overview = collection.overview;
  const sections = selected.map((e) => {
    const detail = `Request body example (${e.body_mode}):\n${e.body}\n${e.description}`;
    return `${e.name}\n${e.method} ${e.path}\nAPI base URL: ${e.base || "Not specified; ask the administrator."}\nAuthentication: ${e.auth_type}\nRequired/documented header names (values must be configured separately): ${e.headers.join(", ")}\nQuery parameter names: ${e.query.join(", ")}\n${detail}`;
  });
  if (selected.some((e) => e.auth_type === "basic"))
    warnings.push(
      "This API uses Basic authentication: Authorization with the “Basic ” prefix and a base64-encoded username:password. Supply your own credential through the selected connection method; documentation examples are not credentials.",
    );
  const index = collection.endpoints.map(e => `${e.method} ${e.path} — ${e.name}`).join("\n");
  const text = `Collection: ${collection.name}\nShared context:\n${overview}\n\nAll documented operations (context only, generate only the selected operations below):\n${index}\n\nSelected operation definitions:\n${sections.join("\n\n---\n\n")}`;
  if (text.length > 180000) throw new HttpError(413, "This endpoint and its shared context exceed the current AI context budget. No documentation was silently truncated; split the reference or configure this endpoint manually.");
  return { text, warnings, selected };
}

/** Structured collections already prove the method/address; don't ask AI to copy a citation. */
export function groundCollectionActions(output, selected) {
  if (!output?.integration) return output;
  const base = output.integration.base_url || "";
  const evidence = [];
  const tools = (Array.isArray(output.integration.tools) ? output.integration.tools : []).filter((tool) => {
    if (typeof tool?.request?.path !== "string") return false;
    const path = tool.request.path.split("?")[0].replace(/\{\{args\.([\w]+)(?:\s*\|\s*url)?\}\}/g, "{$1}");
    const endpoint = selected.find((e) => e.method === tool.request.method && (base ? base.replace(/\/$/, "") + path === e.base + e.path : path === e.path));
    if (!endpoint) return false;
    evidence.push({ name: tool.name, quote: `${endpoint.method} ${endpoint.path}` });
    return true;
  });
  return { ...output, integration: { ...output.integration, tools }, evidence };
}
