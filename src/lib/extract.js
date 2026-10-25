import * as cheerio from "cheerio";
import mammoth from "mammoth";
// The package root runs a self-test when imported as ESM; the library file doesn't.
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { HttpError } from "./http.js";

const clean = (s) =>
  s
    .replace(/ /g, " ")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Main text of an HTML page plus same-site links. */
export function htmlToText(html, pageUrl) {
  const $ = cheerio.load(html);
  const title = clean($("title").first().text()) || clean($("h1").first().text()) || new URL(pageUrl).pathname;
  const links = new Set();
  $("a[href]").each((_, a) => {
    try {
      const u = new URL($(a).attr("href"), pageUrl);
      u.hash = "";
      if (u.origin === new URL(pageUrl).origin && /^https?:$/.test(u.protocol)) links.add(u.href);
    } catch {
      // Ignore malformed links.
    }
  });
  $("script, style, noscript, svg, iframe, form, nav, header, footer, [aria-hidden='true']").remove();
  $("br").replaceWith("\n");
  $("p, div, li, h1, h2, h3, h4, h5, h6, section, article, tr, dd, dt, blockquote, pre, td, th").each((_, el) => {
    $(el).append("\n");
  });
  const root = $("main").length ? $("main") : $("article").length ? $("article") : $("body");
  return { title, text: clean(root.text()), links: [...links] };
}

/** Text sections from an uploaded file. Throws a plain-language error when nothing is readable. */
export async function fileToSections(buffer, name) {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  let sections;
  let pages = null;
  if (ext === "pdf") {
    const pageTexts = [];
    const data = await pdfParse(buffer, {
      pagerender: (page) =>
        page.getTextContent().then((tc) => {
          let last;
          let text = "";
          for (const item of tc.items) {
            text += last === undefined || last === item.transform[5] ? item.str : "\n" + item.str;
            last = item.transform[5];
          }
          pageTexts.push(text);
          return text;
        }),
    }).catch(() => {
      throw new HttpError(422, "We couldn't open this PDF. It may be damaged or password-protected.");
    });
    pages = data.numpages;
    sections = pageTexts.map((t, i) => ({ heading: `${name} · page ${i + 1}`, text: clean(t) }));
  } else if (ext === "docx") {
    const { value } = await mammoth.extractRawText({ buffer }).catch(() => {
      throw new HttpError(422, "We couldn't open this Word file.");
    });
    sections = [{ heading: name, text: clean(value) }];
  } else if (["txt", "md", "csv"].includes(ext)) {
    sections = [{ heading: name, text: clean(buffer.toString("utf8")) }];
  } else {
    throw new HttpError(415, "Upload a PDF, DOCX, TXT, MD or CSV file.");
  }
  sections = sections.filter((s) => s.text.length > 0);
  const chars = sections.reduce((n, s) => n + s.text.length, 0);
  if (chars < 20) {
    throw new HttpError(422, ext === "pdf" ? "We couldn't find readable text in this PDF. It may be scanned images. Upload a text-based PDF or add the content as Q&A." : "This file doesn't contain readable text.");
  }
  return { sections, pages };
}

/** Rejects files whose content doesn't match their extension. */
export function checkFileSignature(buffer, name) {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  const head = buffer.subarray(0, 5).toString("latin1");
  if (ext === "pdf" && !head.startsWith("%PDF")) throw new HttpError(415, "This file isn't a valid PDF.");
  if (ext === "docx" && !head.startsWith("PK")) throw new HttpError(415, "This file isn't a valid Word document.");
  if (["txt", "md", "csv"].includes(ext) && buffer.subarray(0, 4096).includes(0)) throw new HttpError(415, "This doesn't look like a text file.");
}
