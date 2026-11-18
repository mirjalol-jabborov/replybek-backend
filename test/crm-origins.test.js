// Two addresses, one account: the dashboard and the CRM both call the API with the same session.
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";

// A fake Google token endpoint: returns an ID token for whichever profile the test queued, and keeps
// the redirect_uri it was sent (Google refuses an exchange whose redirect_uri differs from the sign-in's).
let profile = null;
let exchangedFor = null;
const google = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    exchangedFor = new URLSearchParams(body).get("redirect_uri");
    const claims = { iss: "https://accounts.google.com", aud: "test-client", exp: Math.floor(Date.now() / 1000) + 3600, ...profile };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id_token: ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join("."), access_token: "x" }));
  });
});
await new Promise((done) => google.listen(0, "127.0.0.1", done));
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.GOOGLE_TOKEN_URL = `http://127.0.0.1:${google.address().port}/token`;
// The dashboard first, then the CRM. Spaces and a trailing slash are forgiven.
process.env.APP_ORIGIN = "http://app.test, http://crm.test/";

const setup = await import("./helpers/setup.js");
after(() => new Promise((done) => google.close(done)));

/** Signs in with Google like a browser would, starting at /auth/google<query>. Returns { redirectUri, location, me }. */
async function signInWithGoogle(claims, query = "") {
  profile = claims;
  const start = await fetch(`${setup.base}/auth/google${query}`, { redirect: "manual" });
  const to = new URL(start.headers.get("location"));
  const back = await fetch(`${setup.base}/auth/google/callback?code=abc&state=${to.searchParams.get("state")}`, { redirect: "manual", headers: { Cookie: start.headers.get("set-cookie").split(";")[0] } });
  const cookie = back.headers.getSetCookie().find((c) => c.startsWith("nx_session=") && !c.startsWith("nx_session=;"))?.split(";")[0];
  const me = cookie ? await fetch(`${setup.base}/auth/me`, { headers: { Cookie: cookie } }).then((r) => r.json()) : null;
  return { redirectUri: to.searchParams.get("redirect_uri"), exchangedFor, location: back.headers.get("location"), me };
}

test("every address in APP_ORIGIN may call the API with the cookie, and nobody else", async () => {
  const allowed = async (origin) => {
    const r = await fetch(`${setup.base}/auth/providers`, { headers: { Origin: origin } });
    return [r.headers.get("access-control-allow-origin"), r.headers.get("access-control-allow-credentials")];
  };
  assert.deepEqual(await allowed("http://app.test"), ["http://app.test", "true"]);
  assert.deepEqual(await allowed("http://crm.test"), ["http://crm.test", "true"]);
  assert.deepEqual(await allowed("http://localhost:5192"), ["http://localhost:5192", "true"], "the CRM app's dev address, outside production");
  assert.equal((await allowed("http://evil.test"))[0], null);
  assert.equal((await allowed("http://crm.test.evil.test"))[0], null);
  // A write from another site is stopped at the preflight: no address to allow, so the browser never sends it.
  const preflight = await fetch(`${setup.base}/auth/register`, { method: "OPTIONS", headers: { Origin: "http://evil.test", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
  assert.equal(preflight.headers.get("access-control-allow-origin"), null);
  assert.equal(process.env.APP_ORIGIN, "http://app.test", "links in emails keep one address: the first");
});

test("Google sign-in returns to the address it started from, and a new account there gets that product", async () => {
  const dash = await signInWithGoogle({ sub: "o-1", email: "aziz@northstar.uz", email_verified: true, name: "Aziz Rahimov" });
  assert.equal(dash.redirectUri, "http://app.test/api/auth/google/callback");
  assert.equal(dash.location, "http://app.test/#/");
  assert.equal(dash.exchangedFor, "http://app.test/api/auth/google/callback");
  assert.deepEqual(dash.me.workspaces[0].products, ["agent"]);

  const crm = await signInWithGoogle({ sub: "o-2", email: "kamola@guldasta.uz", email_verified: true, name: "Kamola Yusupova" }, "?return_to=http://crm.test&product=crm");
  // Google returns to the callback on the CRM's own address, so the session cookie is set there.
  assert.equal(crm.redirectUri, "http://crm.test/api/auth/google/callback");
  assert.equal(crm.exchangedFor, "http://crm.test/api/auth/google/callback", "the code is exchanged with the same redirect_uri");
  assert.equal(crm.location, "http://crm.test/#/");
  assert.deepEqual(crm.me.workspaces[0].products, ["crm"]);

  // Someone who already has an account keeps their workspace as it is, wherever they sign in.
  const again = await signInWithGoogle({ sub: "o-1", email: "aziz@northstar.uz", email_verified: true, name: "Aziz Rahimov" }, "?return_to=http://crm.test/&product=crm");
  assert.equal(again.location, "http://crm.test/#/");
  assert.deepEqual(again.me.workspaces.map((w) => w.products), [["agent"]]);

  // An address that isn't ours is never a place to return to.
  const away = await signInWithGoogle({ sub: "o-1", email: "aziz@northstar.uz", email_verified: true, name: "Aziz Rahimov" }, "?return_to=http://evil.test&product=shop");
  assert.equal(away.location, "http://app.test/#/");
  assert.equal(away.redirectUri, "http://app.test/api/auth/google/callback", "nor a callback to send Google to");
});

test("with COOKIE_DOMAIN the session cookie is shared by both addresses, and a host-only one left from before never gets in the way", async () => {
  const register = (n) => fetch(`${setup.base}/auth/register`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.200" }, body: JSON.stringify({ name: "Alex Morgan", email: `cookie${n}@test.replybek.dev`, password: "correct horse battery", workspace_name: "Northstar" }) });
  const me = (cookie) => fetch(`${setup.base}/auth/me`, { headers: { Cookie: cookie } }).then((r) => r.status);
  const alone = (await register(1)).headers.getSetCookie();
  assert.equal(alone.length, 1);
  assert.match(alone[0], /^nx_session=.+; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Lax$/, "without it the cookie belongs to the host that set it");
  const old = alone[0].split(";")[0];

  process.env.COOKIE_DOMAIN = "replybek.test";
  try {
    const [shared, clearHost, ...rest] = (await register(2)).headers.getSetCookie();
    assert.match(shared, /^nx_session=[^;]+; Max-Age=2592000; Domain=replybek\.test; Path=\/; HttpOnly; SameSite=Lax$/);
    // The host-only cookie from before COOKIE_DOMAIN is a different cookie; signing in clears it,
    // so the browser can't keep sending a dead one ahead of the shared one.
    assert.equal(clearHost, "nx_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax");
    assert.deepEqual(rest, []);
    const live = shared.split(";")[0];

    // A browser that still sends both reaches its account through whichever one is alive,
    // even when the dead one comes first (browsers send the older cookie first).
    await fetch(`${setup.base}/auth/logout`, { method: "POST", headers: { Cookie: old } });
    assert.equal(await me(old), 401);
    assert.equal(await me(`${old}; ${live}`), 200);
    assert.equal(await me("nx_session=; nx_session=nonsense"), 401);

    const out = (await fetch(`${setup.base}/auth/logout`, { method: "POST", headers: { Cookie: `${old}; ${live}` } })).headers.getSetCookie();
    assert.deepEqual(out, ["nx_session=; Max-Age=0; Domain=replybek.test; Path=/; HttpOnly; SameSite=Lax", "nx_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax"]);
    assert.equal(await me(live), 401);

    // Google's round-trip cookie carries the same Domain as the session cookie.
    const start = await fetch(`${setup.base}/auth/google?return_to=http://crm.test&product=crm`, { redirect: "manual" });
    assert.match(start.headers.get("set-cookie"), /^rb_google=[^;]+; Max-Age=600; Domain=replybek\.test; Path=\/; HttpOnly; SameSite=Lax$/);
  } finally {
    delete process.env.COOKIE_DOMAIN;
  }
});
