// Starts the real app against the local test database (replybek_test) with the fake AI.
// Each test file runs in its own process; the test database is emptied when a file starts.
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { after, before } from "node:test";

process.env.NODE_ENV = "test";
process.env.ALLOW_PRIVATE_URLS = "true"; // tests crawl a local server
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `replybek-test-uploads-${process.pid}`);
process.env.S3_BUCKET = ""; // files go to UPLOAD_DIR, even when .env names a bucket

const { default: app } = await import("../../src/app.js");
const { query, closeDb } = await import("../../src/db.js");
const { drainJobs } = await import("../../src/services/jobs.service.js");
const { stopEvents } = await import("../../src/services/events.service.js");
const { dbConfig } = await import("../../src/dbConfig.js");

let server;
export let base;
export { query, drainJobs };

before(async () => {
  assert.equal(dbConfig().database, "replybek_test", "tests only run against the replybek_test database");
  await query("TRUNCATE users, workspaces, jobs, billing_events CASCADE");
  await new Promise((done) => (server = app.listen(0, "127.0.0.1", done)));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await stopEvents();
  await new Promise((done) => server.close(done));
  await closeDb();
});

let ipSeq = 1;
/** A browser with its own cookie jar and address. call(method, path, body, headers) → { status, body }. */
export function browser() {
  let cookie = "";
  const ip = `203.0.113.${ipSeq++}`;
  const call = async (method, p, body, headers = {}) => {
    const isForm = body instanceof FormData;
    const res = await fetch(base + p, {
      method,
      headers: { ...(body && !isForm ? { "Content-Type": "application/json" } : {}), "CF-Connecting-IP": ip, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: res.headers };
  };
  return { call, get cookie() { return cookie; } };
}

let n = 0;
/** Registers a new owner with a workspace. Returns { b (browser), user, ws }. */
export async function owner(name = "Alex Morgan", workspace = "Northstar Outfitters") {
  const b = browser();
  const r = await b.call("POST", "/auth/register", { name, email: `owner${++n}@test.replybek.dev`, password: "correct horse battery", workspace_name: workspace });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { b, user: r.body.user, ws: r.body.workspaces[0] };
}
