import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import YAML from "yaml";
import { safeFetch } from "./safeFetch.js";
import { htmlToText } from "./extract.js";
import { HttpError } from "./http.js";
import { postmanDocumentation, discoverPostman } from "./documentation.js";

const verbs = ["get", "post", "put", "patch", "delete", "head", "options"];
const idOf = value => createHash("sha256").update(value).digest("hex").slice(0,24);

export function textDocumentation(text) {
  const endpoints = [], seen = new Set();
  const declaredBase = text.match(/(?:base\s*(?:url|address)|api\s*(?:url|address))\s*[:=]?\s*(https?:\/\/[^\s<>"'`]+)/i)?.[1]?.replace(/\/$/, "") || "";
  for (const match of text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(https?:\/\/[^\s<>"'`]+|\/[^\s<>"'`]+)/g)) {
    let path = match[2].replace(/[.,;)]$/, "").split("?")[0], base = declaredBase;
    if (/^https?:/.test(path)) { try { const url = new URL(path); base = url.origin; path = url.pathname; } catch { continue; } }
    const key = match[1] + base + path;
    if (seen.has(key) || !path.startsWith("/")) continue;
    if (endpoints.length >= 500) throw new HttpError(413, "This document exceeds 500 endpoints. Split it into smaller references.");
    seen.add(key);
    endpoints.push({ id: idOf(key), name: `${match[1]} ${path}`, group: "", method: match[1], path, base, url: base + path, supported: !["HEAD", "OPTIONS"].includes(match[1]), auth_type: "documented", description: "See the complete shared documentation above.", headers: [], query: [], body: "", body_mode: "documented" });
  }
  return endpoints.length ? { name: "API documentation", overview: text, endpoints, format: "text", coverage: { read: 1, failed: [], limited: false } } : null;
}

export function structuredDocumentation(text, sourceUrl = "") {
  const postman = postmanDocumentation(text);
  if (postman) return { ...postman, format: "postman", coverage: { read: 1, failed: [], limited: false } };
  let doc;
  try { doc = YAML.parse(text, { maxAliasCount: 20 }); } catch { return null; }
  if (!doc || !(String(doc.openapi || "").startsWith("3.") || doc.swagger === "2.0") || !doc.paths) return null;
  const unresolved = new Set();
  let expandedNodes = 0;
  function resolve(value, trail = [], depth = 0) {
    if (++expandedNodes > 200000) throw new HttpError(413, "Expanded schemas exceed the documentation budget. Split the specification.");
    if (!value || typeof value !== "object") return value;
    if (depth > 25) { unresolved.add("Deeply nested schema"); return { description: "Nested schema requires manual review" }; }
    if (value.$ref) {
      const ref = value.$ref;
      if (!ref.startsWith("#/") || trail.includes(ref)) { unresolved.add(ref); return { $ref: ref }; }
      const found = ref.slice(2).split("/").map(s => s.replace(/~1/g,"/").replace(/~0/g,"~")).reduce((v,k) => ["__proto__","constructor","prototype"].includes(k) ? undefined : v?.[k], doc);
      if (!found) { unresolved.add(ref); return { $ref: ref }; }
      return resolve(found, [...trail, ref], depth+1);
    }
    if (Array.isArray(value)) return value.map(v=>resolve(v,trail,depth+1));
    return Object.fromEntries(Object.entries(value).filter(([k])=>!["__proto__","constructor","prototype"].includes(k)).map(([k,v])=>[k,resolve(v,trail,depth+1)]));
  }
  let server = doc.servers?.[0]?.url || (doc.host ? `${doc.schemes?.[0] || "https"}://${doc.host}${doc.basePath || ""}` : "");
  for (const [key,v] of Object.entries(doc.servers?.[0]?.variables || {})) if (v.default != null) server = server.replaceAll(`{${key}}`,String(v.default));
  if (server.startsWith("/") && sourceUrl) server = new URL(server,sourceUrl).href;
  const endpoints = [];
  for (const [path, raw] of Object.entries(doc.paths)) {
    const item = resolve(raw);
    for (const method of verbs) {
      if (!item?.[method]) continue;
      if (endpoints.length >= 500) throw new HttpError(413,"This specification exceeds 500 endpoints. Split it into smaller specifications.");
      const operation = resolve(item[method]);
      const serverUrl = operation.servers?.[0]?.url || item.servers?.[0]?.url || server;
      let base = "", prefix = "";
      try { const u = new URL(serverUrl,sourceUrl || undefined); if (/^https?:$/.test(u.protocol)) {base=u.origin;prefix=u.pathname.replace(/\/$/,"");} } catch {}
      const endpointPath = prefix + path;
      const auth = doc.components?.securitySchemes || doc.securityDefinitions || {};
      const security = operation.security ?? doc.security;
      const schemes = (security || []).flatMap(s=>Object.keys(s)).map(k=>auth[k]).filter(Boolean);
      const authType = Array.isArray(security) && !security.length ? "none" : schemes.some(s=>s.scheme === "basic" || s.type === "basic") ? "basic" : "documented";
      endpoints.push({ id:idOf(method+endpointPath+base), name:operation.summary || operation.operationId || `${method.toUpperCase()} ${path}`, group:(operation.tags || []).join(" / "), method:method.toUpperCase(), path:endpointPath, base, url:base+endpointPath, supported:!["head","options"].includes(method), auth_type:authType,
        description:JSON.stringify({ ...operation, parameters:[...(item.parameters || []),...(operation.parameters || [])], security_schemes:auth }), headers:[], query:[], body:"",body_mode:"schema" });
    }
  }
  return { name:doc.info?.title || "API specification",overview:JSON.stringify({ info:doc.info, security:doc.security, security_schemes:doc.components?.securitySchemes || doc.securityDefinitions, externalDocs:doc.externalDocs }),endpoints,format:"openapi",coverage:{read:1,failed:[],limited:false,unresolved_refs:[...unresolved]} };
}

function specLinks(html, url) {
  const $=cheerio.load(html), links=new Set();
  $("[spec-url],a[href],link[href]").each((_,el)=>{
    const value=$(el).attr("spec-url") || $(el).attr("href");
    if ($(el).attr("spec-url") || /(?:openapi|swagger|collection).*(?:json|ya?ml)|\.(?:json|ya?ml)(?:\?|$)/i.test(value || "")) links.add(value);
  });
  // Read declarative Swagger/ReDoc URLs; never execute script code.
  for (const match of html.matchAll(/(?:\burl|spec-url|specUrl)\s*[:=]\s*["']([^"']+)["']/g)) if (/openapi|swagger|\.json|\.ya?ml/i.test(match[1])) links.add(match[1]);
  return [...links].flatMap(href=>{try{const u=new URL(href,url);return u.origin===new URL(url).origin && /^https?:$/.test(u.protocol)?[u.href]:[];}catch{return[];}}).slice(0,5);
}

/** Format adapters first, then a bounded same-origin documentation crawl. */
export async function readDocumentationSite(first) {
  const raw=first.body.toString("utf8");
  let structured=structuredDocumentation(raw,first.url);
  if (structured) return structured;
  if (!/html/i.test(first.type)) return null;
  structured=await discoverPostman(raw,first.url);
  if (structured) return {...structured,format:"postman",coverage:{read:2,failed:[],limited:false}};
  const $=cheerio.load(raw);
  for (const script of $("script[type='application/json']").toArray()) { structured=structuredDocumentation($(script).text(),first.url);if(structured)return structured; }
  const failures=[];
  let candidates=specLinks(raw,first.url);
  for (const script of $("script[src]").toArray()) {
    const href=$(script).attr("src");
    if (!/swagger-initializer\.js(?:\?|$)/.test(href || "")) continue;
    const u=new URL(href,first.url);
    if(u.origin!==new URL(first.url).origin)continue;
    try { const asset=await safeFetch(u.href,{maxBytes:512000}); candidates.push(...specLinks(asset.body.toString("utf8"),u.href)); } catch { failures.push(u.href); }
  }
  for (const url of [...new Set(candidates)].slice(0,5)) {
    try { const page=await safeFetch(url,{maxBytes:2*1024*1024});if(page.status>=200&&page.status<300)structured=structuredDocumentation(page.body.toString("utf8"),page.url);if(structured)return {...structured,coverage:{...structured.coverage,read:2,failed:failures}};failures.push(url); } catch { failures.push(url); }
  }
  const root=new URL(first.url), pages=[],seen=new Set(),queue=[first],pending=[];
  const prefix=root.pathname.endsWith("/")?root.pathname:root.pathname.slice(0,root.pathname.lastIndexOf("/")+1);
  let bytes=0;
  while(queue.length || pending.length) {
    let page=queue.shift();
    if(!page){const url=pending.shift();try{page=await safeFetch(url,{maxBytes:2*1024*1024,timeoutMs:8000});}catch{failures.push(url);continue;}}
    if(seen.has(page.url))continue;seen.add(page.url);
    if(page.status<200||page.status>=300||!/html|text/i.test(page.type)){failures.push(page.url);continue;}
    bytes+=page.body.length;
    if(bytes>8*1024*1024)break;
    const extracted=htmlToText(page.body.toString("utf8"),page.url);
    pages.push({url:page.url,...extracted});
    for(const href of extracted.links){const u=new URL(href);if(u.origin!==root.origin||seen.has(href)||pending.includes(href)||u.search||/login|logout|sign[-_]?in|delete|remove|\.pdf$/i.test(u.pathname))continue;
      if((prefix!=="/"&&u.pathname.startsWith(prefix))||/(?:^|\/)(?:docs?|reference|api-reference|guides?|authentication|authorization)(?:\/|$)/i.test(u.pathname))pending.push(href);
    }
    if(pages.length>=40)break;
  }
  const endpoints=[],known=new Set();
  for(const page of pages)for(const match of page.text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(https?:\/\/[^\s<>"'`]+|\/[^\s<>"'`]+)/g)){
    let path=match[2].replace(/[.,;)]$/,""),base="";
    if(/^https?:/.test(path)){try{const u=new URL(path);base=u.origin;path=u.pathname;}catch{continue;}}
    if(!path.startsWith("/"))continue;
    const key=match[1]+base+path;if(known.has(key))continue;known.add(key);
    if(endpoints.length>=500)break;
    endpoints.push({id:idOf(key),name:`${match[1]} ${path}`,group:page.title,method:match[1],path,base,url:base+path,supported:!["HEAD","OPTIONS"].includes(match[1]),auth_type:"documented",description:`Documentation page: ${page.url}\n${page.text}`,headers:[],query:[],body:"",body_mode:"documented"});
  }
  if(!endpoints.length)return {name:pages[0]?.title||"Documentation",overview:pages.map(p=>p.text).join("\n\n"),endpoints:[],format:"html",coverage:{read:pages.length,failed:failures,limited:pending.length>0||bytes>8*1024*1024}};
  return {name:pages[0]?.title||"Documentation",overview:pages.filter(p=>!/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\//.test(p.text)).map(p=>`${p.title}\n${p.text}`).join("\n\n"),endpoints,format:"html",coverage:{read:pages.length,failed:failures,limited:pending.length>0||bytes>8*1024*1024}};
}
