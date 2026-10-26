import * as cheerio from "cheerio";
import { safeFetch } from "./safeFetch.js";

/**
 * Reads a business's brand from its home page for onboarding: name, description, language,
 * a square logo (as a data: URL, so the widget never hotlinks the customer's site) and an accent colour.
 * Everything is a best guess the owner confirms; anything not found comes back null.
 */
export async function readBrand(url) {
  // Everything needed is near the top (the <head>, header logo, CSS tokens), so a huge page is just cut short.
  const res = await safeFetch(url, { timeoutMs: 10000, maxBytes: 3 * 1024 * 1024, truncate: true });
  if (res.status >= 400) throw Object.assign(new Error(`The site returned “${res.status}”.`), { status: 400 });
  if (!/html/.test(res.type)) throw Object.assign(new Error("That address isn't a web page."), { status: 400 });
  const html = res.body.toString("utf8");
  const $ = cheerio.load(html);
  const page = new URL(res.url);
  const ld = jsonLd($);
  const description = clean($('meta[name="description"]').attr("content") || $('meta[property="og:description"]').attr("content")).slice(0, 300) || null;
  const mark = await logo($, ld, page);
  return {
    url: res.url,
    host: page.host.replace(/^www\./, ""),
    name: siteName($, ld, page.host),
    description,
    language: language($, description),
    logo: mark,
    accent: accent($, html, mark),
  };
}

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

function jsonLd($) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      const walk = (x) => (Array.isArray(x) ? x.forEach(walk) : x && typeof x === "object" && (out.push(x), x["@graph"] && walk(x["@graph"])));
      walk(data);
    } catch {
      // Broken JSON-LD is common; ignore it.
    }
  });
  return out;
}

const GENERIC_PAGE = /^(home( ?page)?|main( page)?|welcome|index|bosh sahifa|asosiy( sahifa)?|главная( страница)?|домашняя( страница)?)$/i;

// Legal forms in company names ("ООО Green White Solutions", "Acme LLC", "Baraka MChJ").
const LEGAL_FORM = /(^|\s)(ООО|ОАО|ЗАО|АО|ИП|MChJ|XK|AJ|LLC|Ltd\.?|Inc\.?|GmbH|LLP|JSC)(?=\s|$)/gi;

function siteName($, ld, host) {
  const direct = clean($('meta[property="og:site_name"]').attr("content")) || clean($('meta[name="application-name"]').attr("content"));
  if (direct) return direct.slice(0, 80);
  // "Northstar Outfitters – Outdoor gear" or "Home | Northstar": the part that looks like the domain is the
  // brand. It beats the structured-data name, which is often the legal entity ("ООО Green White Solutions").
  const parts = clean($("title").first().text()).split(/\s+[|–—\-·:•]\s+/).filter(Boolean);
  const label = host.replace(/^www\./, "").split(".")[0].toLowerCase();
  const squash = (s) => s.toLowerCase().replace(/[^a-z0-9Ѐ-ӿ]/g, "");
  const match = parts.find((p) => squash(p) && (squash(p).includes(label) || label.includes(squash(p))));
  if (match) return match.slice(0, 80);
  const org = ld.find((x) => /Organization|LocalBusiness|Store|Corporation|WebSite/.test([].concat(x["@type"] || []).join(" ")) && typeof x.name === "string");
  const orgName = clean(clean(org?.name).replace(LEGAL_FORM, " ").replace(/["«»“”]/g, ""));
  if (orgName) return orgName.slice(0, 80);
  // Otherwise skip page names such as "Home" ("Home | Brand"), and take the first part left.
  const named = parts.filter((p) => !GENERIC_PAGE.test(p));
  const name = named[0] || parts[0] || label.charAt(0).toUpperCase() + label.slice(1);
  return name.slice(0, 80);
}

// Common Uzbek (Latin) words, to tell an Uzbek page from an English one without a lang attribute.
const UZBEK = /\b(va|uchun|bilan|bizning|sizning|haqida|mahsulot(lar)?|xizmat(lar)?|buyurtma|yetkazib|narx(lar)?i?|bog['ʻ‘’]lanish|o['ʻ‘’]zbek)\b/gi;

function language($, description) {
  const lang = ($("html").attr("lang") || "").toLowerCase().slice(0, 2);
  if (lang === "uz" || lang === "ru") return lang;
  if (lang) return "en";
  // No lang attribute: judge by the visible words (not inline CSS or scripts, which can be most of the page).
  const body = $("body").clone();
  body.find("script, style, noscript, svg, template").remove();
  const text = [$("title").first().text(), description, body.text()].join(" ").replace(/\s+/g, " ").slice(0, 200000);
  const letters = (text.match(/\p{L}/gu) || []).length || 1;
  if ((text.match(/[Ѐ-ӿ]/g) || []).length > letters * 0.3) return "ru";
  const words = (text.match(/\p{L}+/gu) || []).length || 1;
  return (text.match(UZBEK) || []).length > words * 0.02 ? "uz" : "en";
}

// ───── Logo ─────

const sizeOf = (sizes) => Math.max(0, ...String(sizes || "").split(/\s+/).map((s) => Number(s.split("x")[0]) || 0));

async function logo($, ld, page) {
  const found = [];
  const add = (href, rank) => {
    if (!href || /^data:/.test(href)) return;
    try {
      found.push({ url: new URL(href, page).href, rank });
    } catch {
      // not a usable address
    }
  };
  $("link[rel][href]").each((_, el) => {
    const rel = $(el).attr("rel").toLowerCase().split(/\s+/);
    const href = $(el).attr("href");
    const size = /\.svg(\?|$)/i.test(href) || /svg/.test($(el).attr("type") || "") ? 512 : sizeOf($(el).attr("sizes"));
    // A square app icon reads best as a chat avatar; then the largest favicon.
    if (rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed")) add(href, 1000 + size);
    else if (rel.includes("icon")) add(href, 500 + size);
  });
  for (const x of ld) {
    const l = typeof x.logo === "string" ? x.logo : x.logo?.url;
    if (l) add(l, 400);
  }
  const img = $("header img, [class*=logo] img, img[class*=logo], img[id*=logo], img[alt*=logo i], img[src*=logo]").first();
  add(img.attr("src"), 300);
  add("/favicon.ico", 100);
  const seen = new Set();
  for (const c of found.sort((a, b) => b.rank - a.rank)) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    const data = await image(c.url);
    if (data) return data;
  }
  return null;
}

/** Downloads an image and returns it as a data: URL, or null if it isn't a small, real image. */
async function image(url) {
  try {
    const res = await safeFetch(url, { maxBytes: 200 * 1024, timeoutMs: 6000 });
    if (res.status !== 200 || !res.body.length) return null;
    const mime = imageType(res.body);
    return mime ? `data:${mime};base64,${res.body.toString("base64")}` : null;
  } catch {
    return null;
  }
}

/** The image type from its first bytes; content-type headers on favicons are often wrong. */
export function imageType(b) {
  if (b[0] === 0x89 && b.toString("ascii", 1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "image/x-icon";
  const head = b.toString("utf8", 0, 512).trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

// ───── Accent colour ─────

function hex(value) {
  const v = clean(value).toLowerCase();
  let m = v.match(/^#([0-9a-f]{6})$/) || v.match(/^#([0-9a-f]{3})$/);
  if (m) return m[1].length === 3 ? "#" + [...m[1]].map((c) => c + c).join("") : "#" + m[1];
  m = v.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  if (m) return "#" + m.slice(1, 4).map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("");
  return null;
}

/** A colour worth using as a brand accent: not white, black or gray. */
const lightness = (color) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
};

/** Colours named in an SVG logo (a data: URL), most used first. Raster logos give none. */
function logoColors(mark) {
  if (!mark?.startsWith("data:image/svg+xml;base64,")) return [];
  const svg = Buffer.from(mark.slice(mark.indexOf(",") + 1), "base64").toString("utf8");
  const counts = new Map();
  for (const m of svg.matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|rgba?\([^)]*\)/gi)) {
    const c = hex(m[0]);
    if (c) counts.set(c, (counts.get(c) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

export function usable(color) {
  if (!color) return false;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  return s > 0.25 && l > 0.12 && l < 0.82;
}

function accent($, html, mark) {
  const declared = [$('meta[name="theme-color"]').attr("content"), $('meta[name="msapplication-TileColor"]').attr("content"), $('link[rel="mask-icon"]').attr("color")].map(hex);
  const first = declared.find(usable);
  if (first) return first;
  const css = $("style").text() + " " + $("[style]").map((_, el) => $(el).attr("style")).get().join(" ");
  // Design tokens such as --primary or --brand-color.
  for (const m of css.matchAll(/--[\w-]*(?:primary|brand|accent|main)[\w-]*\s*:\s*(#[0-9a-f]{3,6}\b|rgba?\([^)]*\))/gi)) {
    const c = hex(m[1]);
    if (usable(c)) return c;
  }
  // How often each colourful value appears in the page's own CSS. Near-black text colours (dark but
  // slightly tinted, like #321515) pass `usable` and can be common, so counting wants a lighter floor.
  const counts = new Map();
  for (const m of (css + " " + html.slice(0, 200000)).matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi)) {
    const c = hex(m[0]);
    if (usable(c) && lightness(c) > 0.2) counts.set(c, (counts.get(c) || 0) + 1);
  }
  // The logo's own colours are the brand's: of those, the one the page uses most.
  const inLogo = logoColors(mark).filter(usable);
  if (inLogo.length) return inLogo.sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0))[0];
  const [best] = [...counts].sort((a, b) => b[1] - a[1]);
  return best && best[1] >= 2 ? best[0] : null;
}
