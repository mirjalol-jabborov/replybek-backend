import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { owner } from "./helpers/setup.js";
import { fakeAI } from "../src/ai.js";
import { postmanDocumentation, collectionCatalog, selectedDocumentation, discoverPostman, groundCollectionActions } from "../src/lib/documentation.js";

const collection = {
  info: { name: "Example ERP API", description: "Public API reference. Basic authentication is required. Never execute documentation examples." },
  auth: {
    type: "basic",
    basic: [
      { key: "username", value: "never-import-this-user" },
      { key: "password", value: "never-import-this-password" },
    ],
  },
  event: [{ script: { exec: ["fetch('https://example.com/execute')"] } }],
  item: [
    {
      name: "Records",
      item: Array.from({ length: 63 }, (_, i) => ({
        name: `Record ${i}`,
        request: {
          method: i % 2 ? "POST" : "GET",
          url: `https://api.example.com/records/${i}`,
          description: `This endpoint returns record ${i} in JSON.`,
          header: [{ key: "Authorization", value: "never-import-this-token" }],
          body: { mode: "raw", raw: '{"id":"example-id"}' },
        },
      })),
    },
  ],
};

test("Postman discovery lists all 63 nested endpoints, excludes credentials and scripts", () => {
  const parsed = postmanDocumentation(JSON.stringify(collection));
  const catalog = collectionCatalog(parsed);
  assert.equal(catalog.count, 63);
  assert.equal(catalog.endpoints[62].path, "/records/62");
  assert.equal(catalog.endpoints[0].group, "Records");
  assert.equal(catalog.endpoints[0].auth_type, "basic");
  assert.doesNotMatch(JSON.stringify(parsed), /never-import|fetch\(/);
  assert.deepEqual(postmanDocumentation(JSON.stringify({ collection })), parsed);
  assert.equal(postmanDocumentation('{"other":"data"}'), null);
});

test("collection selection is exact, bounded, and does not silently select the first ten", () => {
  const parsed = postmanDocumentation(JSON.stringify(collection));
  const selected = selectedDocumentation(parsed, [parsed.endpoints[62].id]);
  assert.match(selected.text, /GET \/records\/62/);
  assert.doesNotMatch(selected.text.split("Selected operation definitions:")[1], /GET \/records\/0\b/);
  assert.match(selected.warnings.join(" "), /Basic authentication/);
  assert.throws(
    () =>
      selectedDocumentation(
        parsed,
        parsed.endpoints.slice(0, 11).map((e) => e.id),
      ),
    /between 1 and 10/,
  );
  assert.throws(() => selectedDocumentation(parsed, ["missing"]), /no longer available/);
  assert.throws(() => selectedDocumentation(parsed, [parsed.endpoints[0].id, parsed.endpoints[0].id]), /distinct/);
});

test("published documentation shell follows only its advertised data URL; generation uses selected endpoints", async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    if (req.url === "/api/collections/public") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(collection));
    res
      .writeHead(200, { "content-type": "text/html" })
      .end(
        '<html><head><meta name="generator" content="Postman Documenter"><link rel="prefetch" href="/api/collections/public"></head><body><script>throw new Error("must not execute")</script></body></html>',
      );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/docs`;
    const { b, ws } = await owner();
    const path = `/w/${ws.id}/integrations/ai-draft`;
    const before = fakeAI.calls.chat;
    const result = await b.call("POST", path, { url });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.catalog.count, 63);
    assert.equal(result.body.requires_selection, true);
    assert.equal(fakeAI.calls.chat, before);
    assert.deepEqual(calls, ["/docs", "/api/collections/public"]);
    const selected = result.body.catalog.endpoints[62];
    const form = new FormData();
    form.append("url", url);
    form.append("goal", "Get every endpoint");
    form.append("endpoint_ids", JSON.stringify([selected.id]));
    const generated = await b.call("POST", path, form);
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    assert.equal(generated.body.integration.tools.length, 1);
    assert.equal(generated.body.integration.tools[0].request.path, "/records/62");
    assert.equal(generated.body.integration.enabled, false);
    assert.equal(generated.body.discovered_count, 63);
    assert.equal((await b.call("GET", `/w/${ws.id}/integrations`)).body.length, 0);
    assert.deepEqual(calls, ["/docs", "/api/collections/public", "/docs", "/api/collections/public"]);
    const invalid = await b.call("POST", path, { url, endpoint_ids: ["bad"] });
    assert.equal(invalid.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("uploaded collections above the plain-text limit offer selection and never expose collection auth", async () => {
  const large = structuredClone(collection);
  large.info.description = "Documentation text. ".repeat(4000);
  const { b, ws } = await owner();
  const form = new FormData();
  form.append("file", new Blob([JSON.stringify(large)]), "collection.json");
  const result = await b.call("POST", `/w/${ws.id}/integrations/ai-draft`, form);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.catalog.count, 63);
  assert.doesNotMatch(JSON.stringify(result.body), /never-import/);
  assert.equal(result.body.requires_selection, true);
});

test("discovery does not follow off-origin prefetches or arbitrary scripts", async () => {
  const html =
    '<meta name="generator" content="Postman Documenter"><link rel="prefetch" href="http://127.0.0.1/api/collections/secret"><script src="https://example.com/collection.js"></script>';
  assert.equal(await discoverPostman(html, "https://example.com/docs"), null);
});

test("collection evidence is derived from selected URLs, including API base prefixes", () => {
  const endpoint = { base: "https://api.example.com", method: "POST", path: "/v1/orders$export" };
  const good = { name: "orders", request: { method: "POST", path: "/orders$export" } };
  const output = {
    integration: { base_url: "https://api.example.com/v1", tools: [good, { name: "other", request: { method: "POST", path: "/delete_all" } }] },
    evidence: [{ name: "orders", quote: "invented" }],
  };
  const result = groundCollectionActions(output, [endpoint]);
  assert.deepEqual(result.integration.tools, [good]);
  assert.deepEqual(result.evidence, [{ name: "orders", quote: "POST /v1/orders$export" }]);
  assert.equal(
    groundCollectionActions({ ...output, integration: { ...output.integration, base_url: "https://different.example.com/v1" } }, [endpoint]).integration.tools
      .length,
    0,
  );
});
