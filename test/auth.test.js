import assert from "node:assert/strict";
import { test } from "node:test";
import { browser, owner, query } from "./helpers/setup.js";

test("register signs in with an httpOnly cookie and creates the workspace", async () => {
  const b = browser();
  const r = await b.call("POST", "/auth/register", { name: "Alex", email: "alex@test.replybek.dev", password: "correct horse battery", workspace_name: "Northstar" });
  assert.equal(r.status, 201);
  assert.match(r.headers.get("set-cookie"), /HttpOnly/i);
  assert.equal(r.body.workspaces[0].role, "owner");
  const me = await b.call("GET", "/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, "alex@test.replybek.dev");
  const stored = await query("SELECT password_hash FROM users WHERE email = $1", ["alex@test.replybek.dev"]);
  assert.match(stored.rows[0].password_hash, /^\$2[aby]\$12\$/, "password is bcrypt-hashed");
});

test("wrong password and duplicate email are refused; logout ends the session", async () => {
  const { b } = await owner();
  const me = (await b.call("GET", "/auth/me")).body.user;
  assert.equal((await browser().call("POST", "/auth/login", { email: me.email, password: "nope nope nope" })).status, 401);
  assert.equal((await browser().call("POST", "/auth/login", { email: "nobody@test.replybek.dev", password: "nope nope nope" })).status, 401);
  assert.equal((await browser().call("POST", "/auth/register", { name: "X", email: me.email, password: "correct horse battery", workspace_name: "Y" })).status, 409);
  assert.equal((await b.call("POST", "/auth/logout")).status, 204);
  assert.equal((await b.call("GET", "/auth/me")).status, 401);
  const again = browser();
  assert.equal((await again.call("POST", "/auth/login", { email: me.email, password: "correct horse battery" })).status, 200);
  assert.equal((await again.call("GET", "/auth/me")).status, 200);
});

test("short passwords are rejected", async () => {
  const r = await browser().call("POST", "/auth/register", { name: "A", email: "short@test.replybek.dev", password: "short", workspace_name: "W" });
  assert.equal(r.status, 400);
});

test("one workspace can never see another's data", async () => {
  const a = await owner("Alex", "Northstar");
  const b = await owner("Bea", "Fernway Coffee");
  const agent = (await a.b.call("POST", `/w/${a.ws.id}/agents`, { name: "Store Support" })).body;
  // Bea can't open Alex's workspace…
  assert.equal((await b.b.call("GET", `/w/${a.ws.id}`)).status, 404);
  assert.equal((await b.b.call("GET", `/w/${a.ws.id}/agents`)).status, 404);
  // …nor reach Alex's agent through her own workspace.
  assert.equal((await b.b.call("GET", `/w/${b.ws.id}/agents/${agent.id}`)).status, 404);
  assert.equal((await b.b.call("PATCH", `/w/${b.ws.id}/agents/${agent.id}`, { name: "Hacked" })).status, 404);
  assert.equal((await b.b.call("GET", `/w/${b.ws.id}/agents`)).body.length, 0);
  // Signed out: nothing.
  assert.equal((await browser().call("GET", `/w/${a.ws.id}/agents`)).status, 401);
});

test("dashboard writes must be JSON (cross-site form posts are refused)", async () => {
  const a = await owner();
  const r = await fetch(`${(await import("./helpers/setup.js")).base}/w/${a.ws.id}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: a.b.cookie },
    body: "name=Evil",
  });
  assert.equal(r.status, 415);
});
