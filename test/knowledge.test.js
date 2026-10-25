import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { after, before, test } from "node:test";
import { owner, drainJobs, query } from "./helpers/setup.js";

// A tiny website for the crawler: two help pages, a page robots.txt forbids, and a 404.
let site;
let siteUrl;
before(async () => {
  site = http.createServer((req, res) => {
    const page = (title, body) => `<html><head><title>${title}</title></head><body><nav>Menu Shop Cart</nav><main>${body}</main><footer>© Northstar</footer></body></html>`;
    const routes = {
      "/robots.txt": ["text/plain", "User-agent: *\nDisallow: /private"],
      "/help": ["text/html", page("Help center", `<h1>Help center</h1><p>Find answers about orders. Read our <a href="/help/shipping">shipping page</a> and <a href="/private/staff">staff notes</a>.</p>`)],
      "/help/shipping": ["text/html", page("Shipping and delivery", "<h1>Shipping</h1><p>Standard delivery takes 3–5 business days. Orders above $75 qualify for free standard shipping.</p>")],
      "/private/staff": ["text/html", page("Staff", "<p>Internal discount code STAFF50 for employees only.</p>")],
    };
    const hit = routes[req.url];
    if (!hit) return res.writeHead(404).end("Not found");
    res.writeHead(200, { "content-type": hit[0] }).end(hit[1]);
  });
  await new Promise((done) => site.listen(0, "127.0.0.1", done));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
});
after(() => new Promise((done) => site.close(done)));

async function setup() {
  const o = await owner();
  const w = `/w/${o.ws.id}`;
  const agent = (await o.b.call("POST", `${w}/agents`, { name: "Store Support", purpose: "Answer shipping and returns questions." })).body;
  return { ...o, w, agent, a: `${w}/agents/${agent.id}` };
}

test("a Q&A answer becomes ready and is used, with its source, in the Playground", async () => {
  const { b, a } = await setup();
  const add = await b.call("POST", `${a}/sources/qa`, { question: "Do you offer gift wrapping?", answer: "Yes, gift wrapping is available at checkout for $5." });
  assert.equal(add.status, 202);
  assert.equal(add.body.status, "processing");
  await drainJobs();
  const sources = (await b.call("GET", `${a}/sources`)).body;
  assert.equal(sources[0].status, "ready");
  assert.equal(sources[0].chunk_count, 1);

  const r = await b.call("POST", `${a}/test`, { question: "Is gift wrapping available?" });
  assert.equal(r.status, 200);
  assert.equal(r.body.kind, "answer");
  assert.match(r.body.text, /gift wrapping/i);
  assert.equal(r.body.sources[0].name, "Do you offer gift wrapping?");
});

test("unknown questions get the fallback and are collected as unanswered; adding an answer clears them", async () => {
  const { b, w, a } = await setup();
  await b.call("POST", `${a}/sources/qa`, { question: "Do you offer gift wrapping?", answer: "Yes, for $5." });
  await drainJobs();
  for (let i = 0; i < 2; i++) {
    const r = await b.call("POST", `${a}/test`, { question: "Do you ship to Canada?" });
    assert.equal(r.body.kind, "fallback");
    assert.match(r.body.text, /confident answer/);
  }
  const un = (await b.call("GET", `${w}/unanswered`)).body;
  assert.equal(un.length, 1);
  assert.equal(un[0].times, 2);
  await b.call("POST", `${a}/sources/qa`, { question: "Do you ship to Canada?", answer: "Yes, Canadian orders take 5–8 business days.", unanswered_id: un[0].id });
  await drainJobs();
  assert.ok((await b.call("GET", `${w}/unanswered`)).body[0].answered_at);
  assert.equal((await b.call("POST", `${a}/test`, { question: "Can you ship to Canada?" })).body.kind, "answer");
});

test("Playground draft settings apply without saving", async () => {
  const { b, a } = await setup();
  const r = await b.call("POST", `${a}/test`, { question: "Anything at all?", draft: { fallback: "Draft fallback text." } });
  assert.equal(r.body.text, "Draft fallback text.");
  assert.notEqual((await b.call("GET", a)).body.fallback, "Draft fallback text.");
});

test("asking for a person hands off, unless handoff is turned off", async () => {
  const { b, a } = await setup();
  assert.equal((await b.call("POST", `${a}/test`, { question: "Can I talk to a real person?" })).body.kind, "handoff");
  assert.equal((await b.call("POST", `${a}/test`, { question: "Can I talk to a real person?", draft: { handoff: false } })).body.kind, "fallback");
});

test("flagged messages are refused by moderation", async () => {
  const { b, a } = await setup();
  assert.equal((await b.call("POST", `${a}/test`, { question: "something awful [flag-me]" })).body.kind, "blocked");
});

test("a website and its linked pages are crawled, respecting robots.txt", async () => {
  const { b, a } = await setup();
  const add = await b.call("POST", `${a}/sources/website`, { url: `${siteUrl}/help`, include_linked: true });
  assert.equal(add.status, 202, JSON.stringify(add.body));
  await drainJobs();
  const s = (await b.call("GET", `${a}/sources`)).body[0];
  assert.equal(s.status, "ready", s.error);
  assert.equal(s.pages, 2, "help + shipping; the robots-blocked page is skipped");
  const chunks = await query("SELECT content FROM chunks WHERE source_id = $1", [s.id]);
  const all = chunks.rows.map((r) => r.content).join("\n");
  assert.match(all, /free standard shipping/);
  assert.doesNotMatch(all, /STAFF50/);
  assert.doesNotMatch(all, /Menu Shop Cart/, "navigation is stripped");
  const r = await b.call("POST", `${a}/test`, { question: "How long does standard delivery take?" });
  assert.equal(r.body.kind, "answer");
  assert.equal(r.body.sources[0].name, "Shipping and delivery", "website answers cite the page title");
  assert.equal(r.body.sources[0].url, `${siteUrl}/help/shipping`, "…and link to the page");
});

test("a page that returns 404 ends in a useful error, and retry re-queues it", async () => {
  const { b, w, a } = await setup();
  await b.call("POST", `${a}/sources/website`, { url: `${siteUrl}/missing` });
  await drainJobs();
  const s = (await b.call("GET", `${a}/sources`)).body[0];
  assert.equal(s.status, "error");
  assert.match(s.error, /returned “404”/);
  const retry = await b.call("POST", `${w}/sources/${s.id}/retry`);
  assert.equal(retry.body.status, "processing");
  await drainJobs();
  assert.equal((await b.call("GET", `${a}/sources`)).body[0].status, "error");
});

test("private and internal addresses are refused when not explicitly allowed", async () => {
  const { b, a } = await setup();
  process.env.ALLOW_PRIVATE_URLS = "false";
  try {
    for (const url of ["http://127.0.0.1/admin", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://10.0.0.5/", "localhost", "ftp://example.com/x"]) {
      const r = await b.call("POST", `${a}/sources/website`, { url });
      assert.equal(r.status, 400, `${url} should be refused`);
    }
  } finally {
    process.env.ALLOW_PRIVATE_URLS = "true";
  }
});

test("uploaded text and PDF files are read; wrong file types are refused", async () => {
  const { b, w, a } = await setup();
  const upload = (name, buffer, type) => {
    const form = new FormData();
    form.append("file", new Blob([buffer], { type }), name);
    return b.call("POST", `${a}/sources/file`, form);
  };
  assert.equal((await upload("care.txt", Buffer.from("Wash wool items by hand in cold water and lay them flat to dry."), "text/plain")).status, 202);
  assert.equal((await upload("returns-policy.pdf", fs.readFileSync(new URL("./fixtures/returns-policy.pdf", import.meta.url)), "application/pdf")).status, 202);
  assert.equal((await upload("fake.pdf", Buffer.from("not really a pdf"), "application/pdf")).status, 415);
  assert.equal((await upload("virus.exe", Buffer.from("MZ"), "application/octet-stream")).status, 415);
  await drainJobs();
  const list = (await b.call("GET", `${a}/sources`)).body;
  for (const s of list) assert.equal(s.status, "ready", `${s.name}: ${s.error}`);
  const pdf = list.find((s) => s.name === "returns-policy.pdf");
  assert.equal(pdf.pages, 1);
  const detail = (await b.call("GET", `${w}/sources/${pdf.id}`)).body;
  assert.match(detail.passages[0].content, /30 days/);
  assert.equal((await b.call("POST", `${a}/test`, { question: "Can unworn items be returned?" })).body.kind, "answer");
});

test("removing a source removes its passages", async () => {
  const { b, w, a } = await setup();
  const s = (await b.call("POST", `${a}/sources/qa`, { question: "Gift wrapping?", answer: "Yes." })).body;
  await drainJobs();
  assert.equal((await b.call("DELETE", `${w}/sources/${s.id}`)).status, 204);
  assert.equal((await query("SELECT count(*)::int AS n FROM chunks WHERE source_id = $1", [s.id])).rows[0].n, 0);
  assert.equal((await b.call("DELETE", `${w}/sources/${s.id}`)).status, 404);
});

test("a temporary failure is retried by the job queue", async () => {
  const { b, a } = await setup();
  const { fakeAI } = await import("../src/ai.js");
  const realEmbed = fakeAI.embed;
  let failures = 1;
  fakeAI.embed = async (texts) => {
    if (failures-- > 0) throw new Error("OpenAI is having a moment");
    return realEmbed(texts);
  };
  try {
    await b.call("POST", `${a}/sources/qa`, { question: "Gift wrapping?", answer: "Yes." });
    await drainJobs();
    assert.equal((await b.call("GET", `${a}/sources`)).body[0].status, "processing", "first attempt failed and was re-queued");
    await query("UPDATE jobs SET run_at = now() WHERE status = 'queued'");
    await drainJobs();
    assert.equal((await b.call("GET", `${a}/sources`)).body[0].status, "ready");
  } finally {
    fakeAI.embed = realEmbed;
  }
});

test("handoff rules apply even when no knowledge matches the message", async () => {
  const { b, a } = await setup();
  const damaged = await b.call("POST", `${a}/test`, { question: "My jacket arrived with a torn seam" });
  assert.equal(damaged.body.kind, "handoff");
  const unknown = await b.call("POST", `${a}/test`, { question: "Do you have a store in Paris?" });
  assert.equal(unknown.body.kind, "fallback");
  assert.equal((await b.call("POST", `${a}/test`, { question: "My jacket arrived with a torn seam", draft: { handoff: false } })).body.kind, "fallback");
});
