import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { owner, query, drainJobs } from "./helpers/setup.js";
import { widgetConfig } from "../src/services/widget.service.js";
import { fakeAI } from "../src/ai.js";
import { validateAIDraft, redactDocumentation } from "../src/services/integration-ai.service.js";

async function setup() {
  const o = await owner();
  const w = `/w/${o.ws.id}`;
  const agent = (await o.b.call("POST", `${w}/agents`, { name: "Appointments", purpose: "Help customers book appointments." })).body;
  return { ...o, w, agent, a: `${w}/agents/${agent.id}` };
}
const docs =
  "Calendar API base URL https://api.example.com. API key authentication. GET /appointments lists appointments. POST /appointments creates an appointment.";

test("explicit generation uses ready knowledge and the requested language without saving", async () => {
  const { b, a } = await setup();
  const before = fakeAI.calls.chat;
  assert.deepEqual((await b.call("POST", `${a}/suggestions/generate`, {})).body.questions, []);
  assert.equal(fakeAI.calls.chat, before);
  const source = (
    await b.call("POST", `${a}/sources/qa`, {
      question: "How do I book a dental appointment?",
      answer: "Book a dental appointment using the calendar on our website.",
    })
  ).body;
  await drainJobs();
  const first = await b.call("POST", `${a}/suggestions/generate`, {});
  assert.equal(first.status, 200);
  assert.match(first.body.questions[0], /dental appointment/);
  assert.doesNotMatch(first.body.questions.join(" "), /shipping|return policy/);
  const count = fakeAI.calls.chat;
  const saved = (await b.call("GET", a)).body;
  assert.deepEqual(saved.suggested_questions, []);
  assert.deepEqual(widgetConfig(saved).suggestions, []);
  assert.equal(fakeAI.calls.chat, count);
  const uz = await b.call("POST", `${a}/suggestions/generate`, {}, { "Accept-Language": "uz" });
  assert.match(uz.body.questions[0], /ma’lumot/);
  await query("UPDATE chunks SET heading = 'Dental cleaning', content = 'Dental cleaning visits last one hour.' WHERE source_id = $1", [source.id]);
  assert.match((await b.call("POST", `${a}/suggestions/generate`, {})).body.questions[0], /Dental cleaning/);
  await query("UPDATE sources SET status = 'processing' WHERE id=$1", [source.id]);
  assert.deepEqual((await b.call("POST", `${a}/suggestions/generate`, {})).body.questions, []);
});

test("suggestions reject ungrounded model output and retry after AI failure", async () => {
  const { b, a } = await setup();
  await b.call("POST", `${a}/sources/qa`, {
    question: "When are appointments available?",
    answer: "Appointments are available weekdays between nine and five.",
  });
  await drainJobs();
  const original = fakeAI.chatJSON;
  try {
    fakeAI.chatJSON = async () => {
      throw new Error("Fixture AI failure");
    };
    assert.equal((await b.call("POST", `${a}/suggestions/generate`, {})).status, 500);
    fakeAI.chatJSON = async ({ meta }) => ({
      questions: [
        { text: "Invented shipping question?", source_id: "not-a-passage" },
        { text: "When are appointments available?", source_id: meta.passages[0].id },
      ],
    });
    assert.deepEqual((await b.call("POST", `${a}/suggestions/generate`, {})).body.questions, ["When are appointments available?"]);
  } finally {
    fakeAI.chatJSON = original;
  }
});

test("AI integration generates a disabled draft without persisting or executing it", async () => {
  const { b, w } = await setup();
  const catalog = (await b.call("POST", `${w}/integrations/ai-draft`, { source: docs })).body.catalog;
  const r = await b.call("POST", `${w}/integrations/ai-draft`, { source: docs, endpoint_ids: catalog.endpoints.map(e => e.id) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.integration.enabled, false);
  assert.equal(r.body.integration.tools.length, 2);
  assert.equal(r.body.integration.tools[0].kind, "read");
  assert.equal(r.body.integration.tools[1].kind, "write");
  assert.ok(r.body.integration.tools[1].confirm);
  assert.match(r.body.missing.join(" "), /API key/);
  assert.equal((await b.call("GET", `${w}/integrations`)).body.length, 0);
});

test("documentation files and URLs are read; linked business actions are never called", async () => {
  const { b, w } = await setup();
  const form = new FormData();
  form.append("file", new Blob([docs], { type: "text/plain" }), "api.md");
  const upload = await b.call("POST", `${w}/integrations/ai-draft`, form);
  assert.equal(upload.status, 200, JSON.stringify(upload.body));
  assert.equal(upload.body.source, "api.md");
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    if (req.url === "/redirect") return res.writeHead(302, { Location: "/docs" }).end();
    if (req.url === "/missing") return res.writeHead(404).end();
    res.setHeader("content-type", "text/html");
    res.end(`<main><h1>API</h1><p>${docs}</p><a href="/appointments">Execute</a></main>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const fetched = await b.call("POST", `${w}/integrations/ai-draft`, { url: url + "/redirect" });
    assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
    assert.deepEqual(calls, ["/redirect", "/docs"]);
    assert.equal((await b.call("POST", `${w}/integrations/ai-draft`, { url: url + "/missing" })).status, 422);
    const old = process.env.ALLOW_PRIVATE_URLS;
    try {
      process.env.ALLOW_PRIVATE_URLS = "false";
      assert.equal((await b.call("POST", `${w}/integrations/ai-draft`, { url: "http://127.0.0.1/docs" })).status, 400);
    } finally {
      process.env.ALLOW_PRIVATE_URLS = old;
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("incomplete documentation asks for specifics rather than inventing a connection", async () => {
  const { b, w } = await setup();
  const r = await b.call("POST", `${w}/integrations/ai-draft`, { source: "Welcome to our company. We sell products and provide excellent service." });
  assert.equal(r.status, 200);
  assert.equal(r.body.integration, null);
  assert.ok(r.body.missing.length);
  assert.equal((await b.call("POST", `${w}/integrations/ai-draft`, { source: "too short" })).status, 422);
  assert.equal((await b.call("POST", `${w}/integrations/ai-draft`, { source: "x".repeat(60001) })).status, 400);
  assert.equal((await b.call("POST", `${w}/integrations/ai-draft`, { source: docs, url: "https://example.com" })).status, 400);
});

test("untrusted AI output cannot enable tools, use arbitrary endpoints or preserve connection credentials", () => {
  const raw = {
    integration: {
      name: "Calendar",
      mode: "server",
      base_url: "https://api.example.com",
      enabled: true,
      client_secret: "do-not-store",
      auth: { type: "api_key", client_id: "secret-client" },
      headers: { Authorization: "secret", Accept: "application/json" },
      tools: [
        {
          name: "create_appointment",
          description: "Create appointment",
          kind: "read",
          input: { type: "object", properties: {} },
          request: { method: "POST", path: "/appointments", headers: { Cookie: "secret" } },
        },
        { name: "invented_endpoint", description: "Invented", request: { method: "GET", path: "/payments" } },
        { name: "generic_read", description: "Generic", request: { method: "GET", path: "{{args.path}}" } },
      ],
    },
    evidence: [{ name: "create_appointment", quote: "POST /appointments creates an appointment." }],
  };
  const out = validateAIDraft(raw, docs);
  assert.equal(out.integration.enabled, false);
  assert.equal(out.integration.tools.length, 1);
  assert.equal(out.integration.tools[0].kind, "write");
  assert.deepEqual(out.integration.tools[0].request.headers, {});
  assert.equal(out.integration.client_secret, undefined);
  assert.equal(out.integration.auth.client_id, undefined);
  assert.equal(out.integration.headers.Authorization, undefined);
  assert.throws(() => validateAIDraft({ ...raw, integration: { ...raw.integration, base_url: "https://secret:password@example.com" } }, docs), /API address/);
  assert.equal(validateAIDraft({ ...raw, evidence: [{ name: "create_appointment", quote: "POST /appointments invented evidence" }] }, docs).integration, null);
  assert.doesNotMatch(redactDocumentation('Authorization: Bearer my-secret-key\napi_key="my-key"\nclient_secret=hidden'), /my-secret-key|my-key|hidden/);
});

test("AI setup and suggestions respect workspace and admin boundaries", async () => {
  const one = await setup(),
    two = await setup();
  assert.equal((await two.b.call("POST", `${two.w}/agents/${one.agent.id}/suggestions/generate`, {})).status, 404);
  assert.equal((await two.b.call("POST", `${one.w}/integrations/ai-draft`, { source: docs })).status, 404);
  await query("UPDATE memberships SET role='agent' WHERE workspace_id=$1 AND user_id=$2", [one.ws.id, one.user.id]);
  assert.equal((await one.b.call("POST", `${one.w}/integrations/ai-draft`, { source: docs })).status, 403);
  assert.equal((await one.b.call("POST", `${one.a}/suggestions/generate`, {})).status, 403);
  assert.equal((await one.b.call("PATCH", one.a, { suggested_questions: ["Question?"] })).status, 403);
});

test("admins save, reorder and clear starter questions; regular reads never generate them", async () => {
  const { b, a } = await setup();
  const count = fakeAI.calls.chat;
  const questions = ["How can I book an appointment?", "Can I reschedule a visit?"];
  const saved = await b.call("PATCH", a, { suggested_questions: questions });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.suggested_questions, questions);
  assert.deepEqual(widgetConfig((await b.call("GET", a)).body).suggestions, questions);
  const reversed = await b.call("PATCH", a, { suggested_questions: [...questions].reverse() });
  assert.deepEqual(widgetConfig(reversed.body).suggestions, [...questions].reverse());
  assert.equal((await b.call("PATCH", a, { suggested_questions: Array(6).fill("Too many?") })).status, 400);
  assert.equal((await b.call("PATCH", a, { suggested_questions: ["x".repeat(181)] })).status, 400);
  assert.equal((await b.call("PATCH", a, { suggested_questions: [" "] })).status, 400);
  const empty = await b.call("PATCH", a, { suggested_questions: [] });
  assert.deepEqual(widgetConfig(empty.body).suggestions, []);
  assert.equal(fakeAI.calls.chat, count);
});
