import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";

// A fake Google token endpoint: returns an ID token for whichever profile the test queued.
let profile = null;
const tokenRequests = [];
const google = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    tokenRequests.push(Object.fromEntries(new URLSearchParams(body)));
    const claims = { iss: "https://accounts.google.com", aud: "test-client", exp: Math.floor(Date.now() / 1000) + 3600, ...profile };
    const jwt = ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id_token: jwt, access_token: "x" }));
  });
});
await new Promise((done) => google.listen(0, "127.0.0.1", done));
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.GOOGLE_TOKEN_URL = `http://127.0.0.1:${google.address().port}/token`;
process.env.APP_ORIGIN = "http://app.test";

const setup = await import("./helpers/setup.js");
after(() => new Promise((done) => google.close(done)));

/** Runs the whole round trip like a browser would. Returns { location, cookie, me }. */
async function signInWithGoogle(claims, { tamperState = false } = {}) {
  profile = claims;
  const start = await fetch(`${setup.base}/auth/google`, { redirect: "manual" });
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get("location"));
  const flowCookie = start.headers.get("set-cookie").split(";")[0];
  const state = tamperState ? "forged" : to.searchParams.get("state");
  const back = await fetch(`${setup.base}/auth/google/callback?code=abc&state=${state}`, { redirect: "manual", headers: { Cookie: flowCookie } });
  const session = back.headers.getSetCookie().find((c) => c.startsWith("nx_session=") && !c.startsWith("nx_session=;"));
  const cookie = session?.split(";")[0];
  const me = cookie ? await fetch(`${setup.base}/auth/me`, { headers: { Cookie: cookie } }).then((r) => r.json()) : null;
  return { to, location: back.headers.get("location"), cookie, me };
}

test("providers say Google is available", async () => {
  const r = await fetch(`${setup.base}/auth/providers`).then((x) => x.json());
  assert.deepEqual(r, { google: true });
});

test("a new Google user gets an account and a provisionally named workspace, with PKCE", async () => {
  const { to, location, me } = await signInWithGoogle({ sub: "g-1", email: "dilnoza@northstar.uz", email_verified: true, name: "Dilnoza Karimova" });
  assert.equal(to.searchParams.get("client_id"), "test-client");
  assert.equal(to.searchParams.get("redirect_uri"), "http://app.test/api/auth/google/callback");
  assert.equal(to.searchParams.get("code_challenge_method"), "S256");
  assert.equal(tokenRequests.at(-1).client_secret, "test-secret");
  assert.ok(tokenRequests.at(-1).code_verifier.length >= 43);
  assert.equal(location, "http://app.test/#/");
  assert.equal(me.user.email, "dilnoza@northstar.uz");
  assert.equal(me.workspaces[0].name, "Northstar", "named after the company domain");
  assert.equal(me.workspaces[0].role, "owner");

  const again = await signInWithGoogle({ sub: "g-1", email: "dilnoza@northstar.uz", email_verified: true, name: "Dilnoza Karimova" });
  assert.equal(again.me.user.id, me.user.id, "same account on the next sign-in");
  assert.equal(again.me.workspaces.length, 1, "no second workspace");
});

test("a webmail sign-up is named after the person; renaming clears the provisional flag", async () => {
  const { me, cookie } = await signInWithGoogle({ sub: "g-2", email: "aziz.r@gmail.com", email_verified: true, name: "Aziz Rahimov" });
  const ws = me.workspaces[0];
  assert.equal(ws.name, "Aziz Rahimov");
  const call = (method, path, body) => fetch(setup.base + path, { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, body: body && JSON.stringify(body) }).then((r) => r.json());
  assert.equal((await call("GET", `/w/${ws.id}`)).settings.auto_named, true);
  await call("PATCH", `/w/${ws.id}`, { name: "Kofe Uyi" });
  const s = await call("GET", `/w/${ws.id}`);
  assert.equal(s.name, "Kofe Uyi");
  assert.equal(s.settings.auto_named, undefined);
});

test("an existing password account with the same email is linked, and both ways still work", async () => {
  const { user } = await setup.owner("Bobur Aliyev", "Bobur Store");
  const { me } = await signInWithGoogle({ sub: "g-3", email: user.email, email_verified: true, name: "Bobur A." });
  assert.equal(me.user.id, user.id);
  assert.equal(me.workspaces[0].name, "Bobur Store");
  const pw = await fetch(`${setup.base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: user.email, password: "correct horse battery" }) });
  assert.equal(pw.status, 200);
});

test("Google-only accounts can't be signed into with a password", async () => {
  await signInWithGoogle({ sub: "g-4", email: "only@google-user.uz", email_verified: true, name: "Only Google" });
  const pw = await fetch(`${setup.base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "only@google-user.uz", password: "anything at all" }) });
  assert.equal(pw.status, 401);
});

test("a forged state, an unverified email or a cancelled consent never signs anyone in", async () => {
  const forged = await signInWithGoogle({ sub: "g-5", email: "x@forged.uz", email_verified: true }, { tamperState: true });
  assert.equal(forged.cookie, undefined);
  assert.match(decodeURIComponent(forged.location), /expired/);

  const unverified = await signInWithGoogle({ sub: "g-6", email: "y@unverified.uz", email_verified: false });
  assert.equal(unverified.cookie, undefined);
  assert.match(decodeURIComponent(unverified.location), /isn't verified/);

  const cancelled = await fetch(`${setup.base}/auth/google/callback?error=access_denied`, { redirect: "manual" });
  assert.match(decodeURIComponent(cancelled.headers.get("location")), /cancelled/);
});

test("a token for another app is refused", async () => {
  profile = null;
  const r = await signInWithGoogle({ sub: "g-7", email: "z@other.uz", email_verified: true, aud: "someone-else" });
  assert.equal(r.cookie, undefined);
  assert.match(decodeURIComponent(r.location), /didn't finish/);
});
