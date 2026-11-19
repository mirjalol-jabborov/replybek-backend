// Starts the real app against a local test database (replybek_test, or any name starting with it) with the fake AI.
// Each test file runs in its own process; the test database is emptied when a file starts.
// Several people can run tests at once, each on their own database: PGDATABASE=replybek_test_<name>.
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { after, before } from "node:test";

process.env.NODE_ENV = "test";
process.env.ALLOW_PRIVATE_URLS = "true"; // tests crawl a local server
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `replybek-test-uploads-${process.pid}`);
process.env.S3_BUCKET = ""; // files go to UPLOAD_DIR, even when .env names a bucket

const { default: app } = await import("../../src/app.js");
const { query, closeDb } = await import("../../src/core/db.js");
const { drainJobs } = await import("../../src/core/jobs.js");
const { stopEvents } = await import("../../src/core/events.js");
const { dbConfig } = await import("../../src/core/db-config.js");

let server;
export let base;
export { query, drainJobs };

before(async () => {
  assert.match(String(dbConfig().database), /^replybek_test/, "tests only run against a replybek_test database");
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

const { outbox } = await import("../../src/core/mail.js");

/**
 * Confirms a new account's email the way a person does: the 6-digit code from the email in the
 * outbox, typed into POST /auth/verify by the signed-in browser `b`. Returns the confirmed user.
 */
export async function confirmEmail(b, email) {
  const code = outbox.filter((m) => m.to === email).at(-1)?.text.match(/\b(\d{6})\b/)?.[1];
  assert.ok(code, `no confirmation code was emailed to ${email}`);
  const r = await b.call("POST", "/auth/verify", { code });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.user;
}

let n = 0;
/** Registers a new owner with a workspace and confirms their email. Returns { b (browser), user, ws }. */
export async function owner(name = "Alex Morgan", workspace = "Northstar Outfitters") {
  const b = browser();
  const r = await b.call("POST", "/auth/register", { name, email: `owner${++n}@test.replybek.dev`, password: "correct horse battery", workspace_name: workspace });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { b, user: await confirmEmail(b, r.body.user.email), ws: r.body.workspaces[0] };
}

/** Registers a new owner whose workspace has the CRM only, confirmed. Returns { b, user, ws, crm }: `crm` is the CRM's base path. */
export async function crmOwner(name = "Kamola Yusupova", workspace = "Guldasta") {
  const b = browser();
  const r = await b.call("POST", "/auth/register", { name, email: `owner${++n}@test.replybek.dev`, password: "correct horse battery", workspace_name: workspace, product: "crm" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ws = r.body.workspaces[0];
  return { b, user: await confirmEmail(b, r.body.user.email), ws, crm: `/w/${ws.id}/crm` };
}

/** Invites someone into an owner's workspace and joins as them. Returns { b, user }. */
export async function teammate(o, role = "agent", name = "Sherzod Karimov") {
  const invite = await o.b.call("POST", `/w/${o.ws.id}/invites`, { email: `mate${++n}@test.replybek.dev`, role });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const b = browser();
  const joined = await b.call("POST", `/invites/${invite.body.link.split("/invite/")[1]}/join`, { name, password: "correct horse battery" });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  return { b, user: joined.body.user };
}
