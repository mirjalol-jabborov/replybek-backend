import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { owner } from "./helpers/setup.js";

// Two small business sites: one with full brand metadata, one with almost none.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 4, 0, 0, 0, 22, 0, 0, 0]);
let site, base;
before(async () => {
  site = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    const html = (h) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(h);
    if (url === "/robots.txt") return res.writeHead(200, { "content-type": "text/plain" }).end(`Sitemap: ${base}/sitemap.xml\n`);
    if (url === "/sitemap.xml") return res.writeHead(200, { "content-type": "application/xml" }).end(`<urlset>${["/", "/uz/narxlar/", "/uz/yetkazish/"].map((p) => `<url><loc>${base}${p}</loc></url>`).join("")}</urlset>`);
    if (url === "/") {
      return html(`<!doctype html><html lang="uz"><head><title>Bosh sahifa | Northstar Outfitters</title>
        <meta name="description" content="Toshkentdagi sayohat jihozlari do‘koni.">
        <meta name="theme-color" content="#ffffff">
        <link rel="icon" href="/favicon-16.png" sizes="16x16">
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">
        <style>:root { --brand-primary: #0b6e4f; } body { color: #222222; }</style></head>
        <body><header><img class="logo" src="/logo.png"></header><h1>Northstar</h1></body></html>`);
    }
    if (url === "/apple-touch-icon.png") return res.writeHead(200, { "content-type": "application/octet-stream" }).end(PNG);
    if (url === "/plain/") return html(`<html><head><title>Kofe Uyi – eng yaxshi kofe</title></head><body><style>.btn{background:#c2410c}.link{color:#c2410c}</style><p>Salom</p></body></html>`);
    if (url === "/favicon.ico") return res.writeHead(200, { "content-type": "image/x-icon" }).end(ICO);
    if (url === "/fake-logo.png") return res.writeHead(200, { "content-type": "image/png" }).end("<html>not an image</html>");
    // Over 3 MB of inline CSS (as some real business sites have), no lang attribute, a legal-entity name, a two-colour SVG logo.
    if (url === "/big/") {
      return html(`<html><head><title>Облачная платформа для дистрибуции</title>
        <script type="application/ld+json">{"@type":"Organization","name":"ООО \\"Green White Solutions\\""}</script>
        <link rel="icon" type="image/svg+xml" href="/logo.svg">
        <style>.a{background:#2fc77e} .b{color:#2fc77e} .c{color:#1a9cce} .d{color:#1a9cce} .e{color:#1a9cce} ${".t{color:#321515}".repeat(250000)}</style></head>
        <body><p>Управление дистрибуцией, продажами, складами и финансами в одном месте.</p></body></html>`);
    }
    if (url === "/logo.svg") return res.writeHead(200, { "content-type": "image/svg+xml" }).end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="#0192c9" d="M0 0h5v10H0z"/><path fill="#2fc77e" d="M5 0h5v10H5z"/></svg>`);
    if (url === "/broken/") return html(`<html><head><title>Broken</title><link rel="apple-touch-icon" href="/fake-logo.png"></head><body></body></html>`);
    res.writeHead(404).end("Not found");
  });
  await new Promise((done) => site.listen(0, "127.0.0.1", done));
  base = `http://localhost:${site.address().port}`;
});
after(() => new Promise((done) => site.close(done)));

test("analyze reads the site's name, language, description, square logo, brand colour and pages", async () => {
  const { b, ws } = await owner();
  const r = await b.call("POST", `/w/${ws.id}/onboarding/analyze`, { url: base });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = r.body;
  assert.equal(a.name, "Northstar Outfitters", "the title part that matches the domain or brand");
  assert.equal(a.language, "uz");
  assert.equal(a.description, "Toshkentdagi sayohat jihozlari do‘koni.");
  assert.equal(a.logo, `data:image/png;base64,${PNG.toString("base64")}`, "apple-touch-icon wins, typed by its bytes");
  assert.equal(a.accent, "#0b6e4f", "white theme-color is skipped for the --brand token");
  assert.equal(a.agent_name, "Northstar Outfitters AI agenti");
  assert.match(a.welcome, /^Assalomu alaykum! Men Northstar Outfitters AI agentiman/);
  assert.equal(a.site.total, 3);
  assert.equal(a.site.sitemap, true);
});

test("a bare site falls back to the title, /favicon.ico and its most used colour", async () => {
  const { b, ws } = await owner();
  const a = (await b.call("POST", `/w/${ws.id}/onboarding/analyze`, { url: `${base}/plain/` })).body;
  assert.equal(a.name, "Kofe Uyi");
  assert.equal(a.language, "en");
  assert.equal(a.logo.slice(0, 29), "data:image/x-icon;base64,AAAB");
  assert.equal(a.accent, "#c2410c");
  assert.equal(a.description, null);
});

test("a fake image is never used as the logo; bad addresses get a clear message", async () => {
  const { b, ws } = await owner();
  const a = (await b.call("POST", `/w/${ws.id}/onboarding/analyze`, { url: `${base}/broken/` })).body;
  assert.notEqual(a.logo?.slice(0, 15), "data:image/png;", "HTML served as PNG is refused");
  const missing = await b.call("POST", `/w/${ws.id}/onboarding/analyze`, { url: `${base}/nope/` });
  assert.equal(missing.status, 400);
  assert.match(missing.body.message, /404/);
});

test("the widget logo is saved, served to the widget, and removable; non-images are refused", async () => {
  const { b, ws } = await owner();
  const w = `/w/${ws.id}`;
  const agent = (await b.call("POST", `${w}/agents`, { name: "Help" })).body;
  const logo = `data:image/png;base64,${PNG.toString("base64")}`;
  assert.equal((await b.call("PATCH", `${w}/agents/${agent.id}`, { widget: { logo, accent: "#0b6e4f" } })).status, 200);
  await b.call("POST", `${w}/agents/${agent.id}/publish`);
  const cfg = await fetch(`${(await import("./helpers/setup.js")).base}/widget/${agent.public_key}/config`).then((r) => r.json());
  assert.equal(cfg.logo, logo);
  assert.equal((await b.call("PATCH", `${w}/agents/${agent.id}`, { widget: { logo: "data:text/html;base64,PHNjcmlwdD4=" } })).status, 400);
  await b.call("PATCH", `${w}/agents/${agent.id}`, { widget: { logo: "" } });
  const again = await fetch(`${(await import("./helpers/setup.js")).base}/widget/${agent.public_key}/config`).then((r) => r.json());
  assert.equal(again.logo, null);
});

test("completing onboarding is remembered and keeps the website", async () => {
  const { b, ws } = await owner();
  const r = await b.call("POST", `/w/${ws.id}/onboarding/complete`, { website: "northstar.example" });
  assert.equal(r.status, 200);
  const s = (await b.call("GET", `/w/${ws.id}`)).body;
  assert.equal(s.settings.onboarded, true);
  assert.equal(s.website, "northstar.example");
});

test("a page over 3 MB is read anyway; legal forms are dropped, language is judged by visible text, colour comes from the logo", async () => {
  const { b, ws } = await owner();
  const r = await b.call("POST", `/w/${ws.id}/onboarding/analyze`, { url: `${base}/big/` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.name, "Green White Solutions");
  assert.equal(r.body.language, "ru", "the CSS isn't counted as text");
  assert.equal(r.body.accent, "#2fc77e", "the logo colour the page uses most, not the near-black text colour");
  assert.match(r.body.logo, /^data:image\/svg\+xml;base64,/);
});
