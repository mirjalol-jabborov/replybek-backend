import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { after, before, test } from "node:test";
import { owner, drainJobs, query } from "./helpers/setup.js";

// A Tilda-like docs site: the same menu on every page, Uzbek and Russian sections, a sitemap
// index pointing at a gzipped sitemap, a robots-blocked page and a page listed but missing.
const MENU = ["docsite", "Qo‘llab-quvvatlash xizmati bilan bog‘lanish: +998 71 203 03 05", "РУ", "O'Z", "Ma'lumotnoma markazi", "Tezkor start", "Moliya", "Ombor"];
const docs = new Map();
const uz = (slug, title, body) => docs.set(`/uz/${slug}/`, { title, body });
const ru = (slug, title, body) => docs.set(`/ru/${slug}/`, { title, body });
uz("tmc-yaratish", "TMC qanday yaratiladi", "TMC yaratish uchun Ombor bo‘limiga o‘ting va Yangi tugmasini bosing. Nomini, o‘lchov birligini va artikulni kiriting.");
uz("narx-qoshish", "TMC ga narx qo‘shish", "Narx qo‘shish uchun Narxlar bo‘limida narx turini tanlang va summani kiriting. Narx belgilangan sanadan amal qiladi.");
uz("organizatsiya", "Organizatsiya yaratish", "Organizatsiya yaratish uchun Sozlamalar menyusidan Organizatsiyalar bandini tanlang va INN raqamini kiriting.");
uz("foto-hisobot", "Foto hisobot turlari", "Foto hisobot turini yaratish uchun Savdo vakillari bo‘limida yangi shablon qo‘shing.");
ru("sozdanie-tmc", "Как создать ТМЦ", "Чтобы создать ТМЦ, откройте раздел Склад и нажмите Создать. Укажите наименование и единицу измерения.");
ru("ceny", "Как добавить цену", "Чтобы добавить цену, выберите тип цены в разделе Цены и укажите сумму.");
ru("otchety", "Отчёты по продажам", "Отчёты по продажам строятся в разделе Аналитика за выбранный период.");
for (let i = 1; i <= 6; i++) ru(`stati-${i}`, `Статья ${i}`, `Справочная статья номер ${i} о работе в системе: настройки, права доступа и роли пользователей ${i}.`);
docs.set("/kontakty/", { title: "Kontaktlar", body: "Bizning ofis Toshkent shahrida joylashgan, ish vaqti 9:00 dan 18:00 gacha." });
let failAll = false;
let site, siteUrl;
const page = (title, body) =>
  `<html><head><title>${title}</title></head><body><div class="t-menu">${MENU.map((m) => `<div>${m}</div>`).join("")}</div><div class="t-text"><h1>${title}</h1><p>${body}</p></div><div class="t-footer"><div>© 2026 Docsite</div></div></body></html>`;

before(async () => {
  site = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    if (failAll && url !== "/robots.txt") return res.writeHead(500).end("down");
    if (url === "/robots.txt") return res.writeHead(200, { "content-type": "text/plain" }).end(`User-agent: *\nDisallow: /uz/ichki\nSitemap: ${siteUrl}/sitemap-index.xml\n`);
    if (url === "/sitemap-index.xml") return res.writeHead(200, { "content-type": "application/xml" }).end(`<?xml version="1.0"?><sitemapindex><sitemap><loc>${siteUrl}/sitemap-pages.xml.gz</loc></sitemap></sitemapindex>`);
    if (url === "/sitemap-pages.xml.gz") {
      const locs = [...docs.keys(), "/uz/ichki/maxfiy/", "/uz/ochirilgan/"].map((p) => `<url><loc>${siteUrl}${p}</loc></url>`).join("");
      return res.writeHead(200, { "content-type": "application/gzip" }).end(zlib.gzipSync(`<?xml version="1.0"?><urlset>${locs}</urlset>`));
    }
    const d = docs.get(url);
    if (!d) return res.writeHead(404).end("Not found");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(d.title, d.body));
  });
  await new Promise((done) => site.listen(0, "127.0.0.1", done));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
});
after(() => new Promise((done) => site.close(done)));

async function setup() {
  const o = await owner();
  const w = `/w/${o.ws.id}`;
  const agent = (await o.b.call("POST", `${w}/agents`, { name: "Docs Help" })).body;
  return { ...o, w, agent, a: `${w}/agents/${agent.id}` };
}

test("preview finds the sitemap (index → gzipped), its sections and robots-blocked pages", async () => {
  const { b, a } = await setup();
  const r = await b.call("POST", `${a}/sources/website/preview`, { url: `${siteUrl}/uz/` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sitemap, true);
  assert.equal(r.body.total, docs.size + 1, "all listed pages except the robots-blocked one");
  assert.equal(r.body.blocked_by_robots, 1);
  assert.deepEqual(r.body.sections, [
    { prefix: "/ru/", count: 9 },
    { prefix: "/uz/", count: 5 },
    { prefix: "/", count: 1 },
  ]);
  assert.deepEqual(r.body.suggested_paths, ["/uz/"], "the start URL's folder is suggested");
  assert.equal(r.body.page_limit, 500);
});

test("a chosen section is imported page by page, without the repeated menu", async () => {
  const { b, w, a } = await setup();
  const add = await b.call("POST", `${a}/sources/website`, { url: `${siteUrl}/uz/`, mode: "site", include_paths: ["/uz/"] });
  assert.equal(add.status, 202, JSON.stringify(add.body));
  assert.equal(add.body.sync_interval_days, 7, "whole sites re-sync weekly by default");
  await drainJobs();
  const s = (await b.call("GET", `${w}/sources/${add.body.id}`)).body;
  assert.equal(s.status, "ready", s.error);
  assert.equal(s.discovery, "sitemap");
  assert.equal(s.pages, 4);
  assert.equal(s.pages_failed, 1, "the listed page that 404s");
  assert.match(s.error, /1 page couldn't be read/);
  assert.ok(s.next_sync_at && s.last_synced_at);
  const pages = (await b.call("GET", `${w}/sources/${s.id}/pages`)).body;
  assert.equal(pages.length, 5);
  assert.equal(pages[0].status, "error", "failed pages are listed first");
  assert.match(pages[0].error, /404/);
  const chunks = (await query("SELECT content, url FROM chunks WHERE source_id = $1", [s.id])).rows;
  const text = chunks.map((c) => c.content).join("\n");
  assert.match(text, /Ombor bo‘limiga/);
  assert.doesNotMatch(text, /Qo‘llab-quvvatlash xizmati/, "menu repeated on every page is removed");
  assert.doesNotMatch(text, /Как создать/, "other sections aren't imported");
  assert.ok(chunks.every((c) => c.url?.startsWith(`${siteUrl}/uz/`)), "every passage knows its page");
});

test("answers cite the exact page; Uzbek apostrophes and word endings match by keyword", async () => {
  const { b, a } = await setup();
  await b.call("POST", `${a}/sources/website`, { url: `${siteUrl}/`, mode: "site", include_paths: [] });
  await drainJobs();
  const r = await b.call("POST", `${a}/test`, { question: "Narx qo'shish qanday bo'ladi?" });
  assert.equal(r.body.kind, "answer", JSON.stringify(r.body));
  assert.equal(r.body.sources[0].url, `${siteUrl}/uz/narx-qoshish/`);
  assert.equal(r.body.sources[0].name, "TMC ga narx qo‘shish");
  const { keywordQuery, searchKnowledge } = await import("../src/services/retrieval.service.js");
  assert.equal(keywordQuery("TMC qanday yaratiladi?"), "tmc:* | yarati:*");
  assert.equal(keywordQuery("Qo‘shiladi"), "qoshi:*", "apostrophe removed, ending cut");
  const agentId = a.split("/").pop();
  const hits = await searchKnowledge(agentId, new Array(1536).fill(0).map((_, i) => (i === 0 ? 1 : 0)), keywordQuery("yaratiladi"));
  assert.ok(hits.some((h) => h.keyword != null && /tmc-yaratish|organizatsiya/.test(h.url)), "yarati* finds pages with yaratish");
});

test("re-sync re-embeds only changed pages, adds new ones and drops removed ones", async () => {
  const { b, w, a } = await setup();
  const add = (await b.call("POST", `${a}/sources/website`, { url: `${siteUrl}/uz/`, mode: "site" })).body;
  await drainJobs();
  const { fakeAI } = await import("../src/ai.js");
  const real = fakeAI.embed;
  let embedded = [];
  fakeAI.embed = async (texts) => {
    embedded.push(...texts);
    return real(texts);
  };
  const saved = new Map(docs);
  try {
    docs.get("/uz/narx-qoshish/").body = "Narx qo‘shish uchun YANGI tartib: Narxlar bo‘limida Import tugmasini bosing.";
    docs.delete("/uz/foto-hisobot/");
    uz("yangi-sahifa", "Yangi sahifa", "Bu yangi qo‘llanma sahifasi ombor qoldiqlarini tekshirish haqida.");
    const r = await b.call("POST", `${w}/sources/${add.id}/resync`);
    assert.equal(r.status, 202);
    assert.equal(r.body.syncing, true);
    assert.equal(r.body.status, "ready", "still answering while it syncs");
    await drainJobs();
    assert.ok(embedded.length >= 2, "changed and new pages are embedded");
    assert.ok(embedded.every((t) => /YANGI tartib|Yangi sahifa/.test(t)), `only changed/new pages embedded, got: ${embedded.map((t) => t.slice(0, 30)).join(" | ")}`);
    const pages = (await b.call("GET", `${w}/sources/${add.id}/pages?status=ready`)).body.map((p) => p.url.replace(siteUrl, ""));
    assert.ok(pages.includes("/uz/yangi-sahifa/"));
    assert.ok(!pages.includes("/uz/foto-hisobot/"), "removed page is gone");
    const s = (await b.call("GET", `${w}/sources/${add.id}`)).body;
    assert.equal(s.syncing, false);
    assert.match(s.passages.map((p) => p.content).join(" ") + (await query("SELECT string_agg(content, ' ') AS t FROM chunks WHERE source_id = $1", [add.id])).rows[0].t, /YANGI tartib/);
  } finally {
    fakeAI.embed = real;
    docs.clear();
    for (const [k, v] of saved) docs.set(k, v);
  }
});

test("a failed re-sync keeps the pages already imported", async () => {
  const { b, w, a } = await setup();
  const add = (await b.call("POST", `${a}/sources/website`, { url: `${siteUrl}/ru/`, mode: "site" })).body;
  await drainJobs();
  const before = (await query("SELECT count(*)::int AS n FROM chunks WHERE source_id = $1", [add.id])).rows[0].n;
  failAll = true;
  try {
    await b.call("POST", `${w}/sources/${add.id}/resync`);
    await drainJobs();
  } finally {
    failAll = false;
  }
  const s = (await b.call("GET", `${w}/sources/${add.id}`)).body;
  assert.equal(s.status, "ready");
  assert.match(s.error, /^Last sync failed/);
  assert.equal((await query("SELECT count(*)::int AS n FROM chunks WHERE source_id = $1", [add.id])).rows[0].n, before);
  assert.equal((await b.call("POST", `${a}/test`, { question: "Как добавить цену?" })).body.kind, "answer");
});

test("due websites re-sync automatically; the interval can be changed or turned off", async () => {
  const { b, w, a } = await setup();
  const add = (await b.call("POST", `${a}/sources/website`, { url: `${siteUrl}/uz/`, mode: "site" })).body;
  await drainJobs();
  const { enqueueDueSyncs } = await import("../src/services/jobs.service.js");
  await query("UPDATE sources SET next_sync_at = now() - interval '1 minute', last_synced_at = now() - interval '8 days' WHERE id = $1", [add.id]);
  assert.equal(await enqueueDueSyncs(), 1);
  assert.equal(await enqueueDueSyncs(), 0, "not queued twice");
  await drainJobs();
  const s = (await b.call("GET", `${w}/sources/${add.id}`)).body;
  assert.ok(new Date(s.last_synced_at) > new Date(Date.now() - 60000));
  const off = (await b.call("PATCH", `${w}/sources/${add.id}`, { sync_interval_days: 0 })).body;
  assert.equal(off.next_sync_at, null);
  assert.equal((await b.call("PATCH", `${w}/sources/${add.id}`, { sync_interval_days: 3 })).status, 400);
});

test("imports stop at the plan's page limit and say so", async () => {
  const { b, w, a } = await setup();
  const { PLANS } = await import("../src/services/workspaces.service.js");
  const limit = PLANS.starter.pages;
  PLANS.starter.pages = 5;
  try {
    assert.equal((await b.call("PATCH", w.replace(/\/$/, "") + "/plan", { plan: "starter" })).status, 200);
    const add = (await b.call("POST", `${a}/sources/website`, { url: `${siteUrl}/ru/`, mode: "site" })).body;
    await drainJobs();
    const s = (await b.call("GET", `${w}/sources/${add.id}`)).body;
    assert.equal(s.pages, 5);
    assert.equal(s.pages_over_limit, 4);
    assert.match(s.error, /4 more pages skipped by your plan's limit of 5/);
  } finally {
    PLANS.starter.pages = limit;
  }
});

test("a single page can still be added on its own", async () => {
  const { b, w, a } = await setup();
  const add = (await b.call("POST", `${a}/sources/website`, { url: `${siteUrl}/kontakty/`, mode: "page" })).body;
  await drainJobs();
  const s = (await b.call("GET", `${w}/sources/${add.id}`)).body;
  assert.equal(s.status, "ready", s.error);
  assert.equal(s.pages, 1);
  assert.equal(s.discovery, "page");
  assert.equal(s.sync_interval_days, 0);
});

test("slow pages are retried once, and a page is cited only once", async () => {
  const { b, w, a } = await setup();
  // A page that fails the first time (busy server), then works.
  let busy = 1;
  const slow = http.createServer((req, res) => {
    if (req.url === "/robots.txt") return res.writeHead(404).end();
    if (req.url === "/sitemap.xml") return res.writeHead(200).end(`<urlset><url><loc>http://127.0.0.1:${slow.address().port}/docs/a/</loc></url></urlset>`);
    if (busy-- > 0) return res.writeHead(503).end("busy");
    const long = Array.from({ length: 30 }, (_, i) => `Ombor qoldiqlarini tekshirish bo‘yicha qadam ${i}. Inventarizatsiya hujjatini oching va qoldiqlarni solishtiring.`).join("\n\n");
    res.writeHead(200, { "content-type": "text/html" }).end(`<title>Ombor qoldiqlari</title><p>${long.replace(/\n\n/g, "</p><p>")}</p>`);
  });
  await new Promise((done) => slow.listen(0, "127.0.0.1", done));
  try {
    const add = (await b.call("POST", `${a}/sources/website`, { url: `http://127.0.0.1:${slow.address().port}/docs/`, mode: "site" })).body;
    await drainJobs();
    const s = (await b.call("GET", `${w}/sources/${add.id}`)).body;
    assert.equal(s.status, "ready", s.error);
    assert.equal(s.pages_failed, 0, "the 503 was retried");
    assert.ok(s.chunk_count > 1, "long page split into several passages");
    const r = (await b.call("POST", `${a}/test`, { question: "Ombor qoldiqlarini tekshirish inventarizatsiya [cite-all]" })).body;
    assert.equal(r.kind, "answer");
    assert.equal(r.sources.length, 1, "several passages from one page → one citation");
  } finally {
    slow.close();
  }
});
