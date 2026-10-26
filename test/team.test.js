import assert from "node:assert/strict";
import { test } from "node:test";
import { owner, browser, drainJobs, query, base } from "./helpers/setup.js";

const { outbox } = await import("../src/lib/mail.js");
const mailTo = (to) => outbox.filter((m) => m.to === to);
const tokenIn = (mail, kind) => mail.text.match(new RegExp(`#/${kind}/([A-Za-z0-9_-]+)`))?.[1];
let n = 0;
const email = (who) => `${who}${++n}@team.test.replybek.dev`;

test("an admin invites a teammate by email; they join with a new account", async () => {
  const { b, ws } = await owner();
  const w = `/w/${ws.id}`;
  const to = email("dilnoza");
  const sent = await b.call("POST", `${w}/invites`, { email: to }, { "Accept-Language": "uz" });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body.role, "agent");
  assert.match(sent.body.link, /#\/invite\//, "the admin gets the link too, to share another way");

  const [mail] = mailTo(to);
  assert.ok(mail, "an email went out");
  assert.match(mail.subject, /Northstar Outfitters/);
  assert.match(mail.text, /jamoasiga/, "in the inviter's language");
  assert.match(mail.html, /replybek<span style="color:#2d5bd2">\.<\/span>/, "with the brand's wordmark");
  const token = tokenIn(mail, "invite");
  assert.equal(sent.body.link.split("/invite/")[1], token);

  const info = await browser().call("GET", `/invites/${token}`);
  assert.deepEqual({ ...info.body }, { workspace: "Northstar Outfitters", inviter: "Alex Morgan", email: to, role: "agent", has_account: false });
  assert.equal((await b.call("GET", `${w}/invites`)).body.length, 1);

  const newbie = browser();
  const joined = await newbie.call("POST", `/invites/${token}/join`, { name: "Dilnoza Karimova", password: "a long enough password" });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  assert.equal(joined.body.workspace_id, ws.id);
  assert.equal((await newbie.call("GET", `${w}/conversations`)).status, 200, "signed in and inside the workspace");
  const members = (await b.call("GET", `${w}/members`)).body;
  assert.equal(members.find((m) => m.email === to).role, "agent");
  assert.equal((await b.call("GET", `${w}/invites`)).body.length, 0, "the invitation is used up");
  assert.equal((await browser().call("GET", `/invites/${token}`)).status, 410);
  assert.equal((await browser().call("POST", `/invites/${token}/join`, { name: "Again", password: "a long enough password" })).status, 410);
  assert.equal((await browser().call("GET", "/invites/not-a-real-token-at-all-123")).status, 404);
});

test("someone with an account accepts while signed in, and only with the invited address", async () => {
  const { b, ws } = await owner();
  const w = `/w/${ws.id}`;
  const other = await owner("Bekzod Aliev", "Bekzod Shop");
  const stranger = await owner("Sardor", "Sardor Shop");
  await b.call("POST", `${w}/invites`, { email: other.user.email, role: "admin" });
  const token = tokenIn(mailTo(other.user.email).at(-1), "invite");
  assert.equal((await browser().call("GET", `/invites/${token}`)).body.has_account, true);

  assert.equal((await browser().call("POST", `/invites/${token}/accept`)).status, 401, "signed out");
  assert.equal((await stranger.b.call("POST", `/invites/${token}/accept`)).status, 403, "a different account");
  assert.equal((await browser().call("POST", `/invites/${token}/join`, { name: "Imposter", password: "a long enough password" })).status, 409, "can't make a second account for the address");
  const ok = await other.b.call("POST", `/invites/${token}/accept`);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.workspaces.some((x) => x.id === ws.id && x.role === "admin"));
});

test("seats, resending and revoking; only admins manage the team", async () => {
  const { b, ws } = await owner();
  const w = `/w/${ws.id}`;
  await query("UPDATE workspaces SET plan = 'starter' WHERE id = $1", [ws.id]); // 2 seats
  const first = email("a");
  const sent = (await b.call("POST", `${w}/invites`, { email: first })).body;
  const full = await b.call("POST", `${w}/invites`, { email: email("b") });
  assert.equal(full.status, 402, "owner + one invitation fill the starter plan");
  assert.equal(full.body.seats, 2);
  assert.equal((await b.call("POST", `${w}/invites`, { email: first.toUpperCase() })).status, 201, "inviting the same address again renews it");

  const old = tokenIn(mailTo(first).at(-1), "invite");
  const again = await b.call("POST", `${w}/invites/${sent.id}/resend`);
  assert.equal(again.status, 200);
  const fresh = tokenIn(mailTo(first).at(-1), "invite");
  assert.notEqual(fresh, old);
  assert.equal((await browser().call("GET", `/invites/${old}`)).status, 404, "the old link stops working");

  assert.equal((await b.call("DELETE", `${w}/invites/${sent.id}`)).status, 204);
  assert.equal((await browser().call("GET", `/invites/${fresh}`)).status, 404);
  assert.equal((await b.call("POST", `${w}/invites`, { email: email("c") })).status, 201, "a revoked invitation frees its seat");

  // Expired invitations can't be used.
  await query("UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE workspace_id = $1", [ws.id]);
  const expired = tokenIn(outbox.at(-1), "invite");
  assert.equal((await browser().call("GET", `/invites/${expired}`)).status, 410);

  // An agent can't invite or change the team.
  await query("UPDATE workspaces SET plan = 'growth' WHERE id = $1", [ws.id]);
  const agentEmail = email("agent");
  await b.call("POST", `${w}/invites`, { email: agentEmail });
  const agent = browser();
  await agent.call("POST", `/invites/${tokenIn(mailTo(agentEmail).at(-1), "invite")}/join`, { name: "Agent Smith", password: "a long enough password" });
  assert.equal((await agent.call("POST", `${w}/invites`, { email: email("x") })).status, 403);
  assert.equal((await agent.call("GET", `${w}/invites`)).status, 403);
});

test("admins change roles and remove teammates; the owner stays", async () => {
  const { b, ws, user } = await owner();
  const w = `/w/${ws.id}`;
  const to = email("mate");
  await b.call("POST", `${w}/invites`, { email: to });
  const mate = browser();
  const joined = (await mate.call("POST", `/invites/${tokenIn(mailTo(to).at(-1), "invite")}/join`, { name: "Team Mate", password: "a long enough password" })).body;
  const id = joined.user.id;

  const promoted = await b.call("PATCH", `${w}/members/${id}`, { role: "admin" });
  assert.equal(promoted.body.find((m) => m.id === id).role, "admin");
  assert.equal((await mate.call("PATCH", `${w}/members/${user.id}`, { role: "agent" })).status, 409, "the owner's role is fixed");
  assert.equal((await mate.call("DELETE", `${w}/members/${user.id}`)).status, 409, "the owner can't be removed");
  assert.equal((await b.call("DELETE", `${w}/members/${user.id}`)).status, 409, "nor remove themselves");

  assert.equal((await b.call("DELETE", `${w}/members/${id}`)).status, 204);
  assert.equal((await mate.call("GET", `${w}/conversations`)).status, 404, "a removed teammate loses access");
});

test("forgot password: a one-hour, one-use link that signs out everywhere else", async () => {
  const { b, user } = await owner();
  assert.equal((await browser().call("POST", "/auth/password/forgot", { email: "nobody@team.test.replybek.dev" })).status, 200, "same answer for unknown addresses");
  assert.equal(mailTo("nobody@team.test.replybek.dev").length, 0);

  assert.equal((await browser().call("POST", "/auth/password/forgot", { email: user.email }, { "Accept-Language": "ru" })).status, 200);
  const mail = mailTo(user.email).at(-1);
  assert.match(mail.subject, /Сброс пароля/);
  const token = tokenIn(mail, "reset");

  const fresh = browser();
  assert.equal((await fresh.call("POST", "/auth/password/reset", { token, password: "short" })).status, 400);
  const reset = await fresh.call("POST", "/auth/password/reset", { token, password: "a brand new passphrase" });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal((await fresh.call("GET", "/auth/me")).status, 200, "signed in with the new password");
  assert.equal((await b.call("GET", "/auth/me")).status, 401, "the old session is signed out");
  assert.equal((await browser().call("POST", "/auth/login", { email: user.email, password: "a brand new passphrase" })).status, 200);
  assert.equal((await browser().call("POST", "/auth/password/reset", { token, password: "another new passphrase" })).status, 400, "one use");
});

test("the team gets an email when a customer waits and nobody has the inbox open", async () => {
  const { b, ws, user } = await owner();
  const w = `/w/${ws.id}`;
  await b.call("GET", `${w}`, null, { "Accept-Language": "uz" }); // the owner uses the dashboard in Uzbek
  const agent = (await b.call("POST", `${w}/agents`, { name: "Store Support" })).body;
  await b.call("POST", `${w}/agents/${agent.id}/sources/qa`, { question: "What is your return policy?", answer: "Within 30 days." });
  await drainJobs();
  await b.call("POST", `${w}/agents/${agent.id}/publish`);
  const site = { Origin: "https://northstar.example" };

  const chat = async () => {
    const v = browser();
    const { conversation_id: id, visitor_token: token } = (await v.call("POST", `/widget/${agent.public_key}/conversations`, { page: "/" }, site)).body;
    const as = { ...site, "X-Visitor-Token": token };
    await v.call("POST", `/widget/${agent.public_key}/conversations/${id}/messages`, { text: "My parcel arrived broken" }, as);
    return { id, ask: () => v.call("POST", `/widget/${agent.public_key}/conversations/${id}/handoff`, null, as) };
  };
  const waitFor = async (fn) => {
    for (let i = 0; i < 40 && !fn(); i++) await new Promise((r) => setTimeout(r, 25));
    return fn();
  };

  const before = mailTo(user.email).length;
  const one = await chat();
  await one.ask();
  assert.ok(await waitFor(() => mailTo(user.email).length === before + 1), "emailed");
  const mail = mailTo(user.email).at(-1);
  assert.match(mail.subject, /Mijoz xodimni kutmoqda/, "in the language the owner uses");
  assert.match(mail.text, /My parcel arrived broken/);
  assert.match(mail.text, new RegExp(`#/inbox/${one.id}`));
  await one.ask();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(mailTo(user.email).length, before + 1, "once per conversation, not on every request");

  // With the inbox open, the dashboard shows it live and nobody is emailed.
  const ctl = new AbortController();
  const res = await fetch(`${base}${w}/stream`, { headers: { Cookie: b.cookie }, signal: ctl.signal });
  const reader = res.body.getReader();
  await reader.read();
  try {
    const two = await chat();
    await two.ask();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(mailTo(user.email).length, before + 1);
  } finally {
    ctl.abort();
  }
});
