// Confirming the email address of a new account: a 6-digit code or a one-click link from the
// email, before any workspace opens.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { browser, owner, query, drainJobs } from "./helpers/setup.js";

const { outbox } = await import("../src/core/mail.js");
const lastMail = (to) => outbox.filter((m) => m.to === to).at(-1);
const codeIn = (mail) => mail?.text.match(/\b(\d{6})\b/)?.[1];
const linkIn = (mail) => mail?.text.match(/(\S+)#\/verify\/([A-Za-z0-9_-]+)/);
let n = 0;
const address = (who = "new") => `${who}${++n}@verify.test.replybek.dev`;
const PASSWORD = "correct horse battery";

/** Registers without confirming. Returns { b, email, ws, body }. */
async function signUp(headers = {}, extra = {}) {
  const b = browser();
  const email = address();
  const r = await b.call("POST", "/auth/register", { name: "Alex Morgan", email, password: PASSWORD, workspace_name: "Northstar", ...extra }, headers);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { b, email, ws: r.body.workspaces[0], body: r.body };
}
const refused = (r) => {
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.code, "email_unverified");
};
const failsWith = (r, status, code) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.equal(r.body.code, code);
  assert.ok(r.body.message, "a sentence to show");
};
// The waits are measured by the database's clock; a test moves the row back instead of sleeping.
const age = (email, column, seconds) => query(`UPDATE email_verifications SET ${column} = ${column} - make_interval(secs => $2) WHERE email = $1`, [email, seconds]);

test("a new account is created unconfirmed, says so, and gets a code and a link by email", async () => {
  const { b, email, body } = await signUp({ "Accept-Language": "ru" });
  assert.equal(body.user.email_verified, false);
  assert.equal(body.verification.email, email);
  assert.ok(body.verification.resend_in > 0 && body.verification.resend_in <= 60);
  const me = await b.call("GET", "/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email_verified, false);
  assert.equal(me.body.verification.email, email);

  const mail = lastMail(email);
  assert.match(mail.subject, /\d{6}/, "the code is in the subject, readable from a phone's notification");
  assert.match(mail.subject, /Replybek/);
  assert.match(mail.text, /Подтвердите/, "in the language the person signed up in");
  assert.match(mail.html, /#\/verify\//);
  const code = codeIn(mail);
  const token = linkIn(mail)[2];
  // Stored as hashes only.
  const row = (await query("SELECT * FROM email_verifications WHERE email = $1", [email])).rows[0];
  assert.ok(row);
  assert.ok(!JSON.stringify(row).includes(code), "the code isn't stored");
  assert.ok(!JSON.stringify(row).includes(token), "the link isn't stored");
});

test("until confirmed, every workspace route is refused with one code; sign out and /auth/me still work", async () => {
  const { b, ws } = await signUp();
  refused(await b.call("GET", `/w/${ws.id}`));
  refused(await b.call("GET", `/w/${ws.id}/agents`));
  refused(await b.call("POST", `/w/${ws.id}/agents`, { name: "Store Support" }));
  refused(await b.call("GET", `/w/${ws.id}/members`));
  refused(await b.call("GET", `/w/${ws.id}/stream`));
  // A workspace that isn't theirs reads the same: nothing about it leaks.
  refused(await b.call("GET", "/w/00000000-0000-0000-0000-000000000000"));
  const crm = await signUp({}, { product: "crm" });
  refused(await crm.b.call("GET", `/w/${crm.ws.id}/crm/snapshot`));
  assert.equal((await b.call("GET", "/auth/me")).status, 200);
  assert.equal((await b.call("POST", "/auth/logout")).status, 204);
  assert.equal((await b.call("GET", "/auth/me")).status, 401);
  assert.equal((await b.call("GET", `/w/${ws.id}`)).status, 401, "signed out is still 401");
});

test("signing in to an unconfirmed account works and says it needs confirming", async () => {
  const { email } = await signUp();
  const again = browser();
  const r = await again.call("POST", "/auth/login", { email, password: PASSWORD });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.email_verified, false);
  assert.equal(r.body.verification.email, email);
});

test("the right code confirms the account and opens the workspace", async () => {
  const { b, email, ws } = await signUp();
  const code = codeIn(lastMail(email));
  failsWith(await b.call("POST", "/auth/verify", { code: "12" }), 400, "code_wrong");
  const r = await b.call("POST", "/auth/verify", { code: ` ${code.slice(0, 3)} ${code.slice(3)} ` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.email_verified, true);
  assert.equal(r.body.workspaces[0].id, ws.id);
  assert.equal(r.body.verification, undefined);
  assert.equal((await b.call("GET", `/w/${ws.id}`)).status, 200);
  assert.equal((await b.call("GET", "/auth/me")).body.user.email_verified, true);
  // Confirmed once: the code is used, and asking again changes nothing.
  assert.equal((await b.call("POST", "/auth/verify", { code })).status, 200);
  failsWith(await b.call("POST", "/auth/verify/resend"), 409, "already_verified");
  assert.equal((await query("SELECT email_verified_at IS NOT NULL AS ok FROM users WHERE email = $1", [email])).rows[0].ok, true);
});

test("the link confirms in one click, signs in on any browser, works once, and leads back to the app the person signed up on", async () => {
  const { email, ws } = await signUp();
  const [, origin, token] = linkIn(lastMail(email));
  assert.equal(origin, `${process.env.APP_ORIGIN}/`, "the dashboard by default");
  const phone = browser();
  const r = await phone.call("POST", "/auth/verify/link", { token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.email_verified, true);
  assert.equal(r.body.user.email, email);
  assert.equal((await phone.call("GET", `/w/${ws.id}`)).status, 200, "signed in by the link");
  failsWith(await browser().call("POST", "/auth/verify/link", { token }), 400, "link_used");
  failsWith(await browser().call("POST", "/auth/verify/link", { token: "x".repeat(43) }), 400, "link_invalid");
  assert.equal((await browser().call("POST", "/auth/verify/link", { token: "short" })).status, 400);

  // Signed up on the CRM: the link opens the CRM. An address that isn't ours never counts.
  const crm = await signUp({ Origin: "http://localhost:5192" }, { product: "crm" });
  assert.equal(linkIn(lastMail(crm.email))[1], "http://localhost:5192/");
  const away = await signUp({ Origin: "http://evil.test" });
  assert.equal(linkIn(lastMail(away.email))[1], `${process.env.APP_ORIGIN}/`);
});

test("wrong codes are counted: after five the code is dead until a new one is sent", async () => {
  const { b, email, ws } = await signUp();
  const code = codeIn(lastMail(email));
  const wrong = code === "000000" ? "111111" : "000000";
  for (let left = 4; left >= 1; left--) {
    const r = await b.call("POST", "/auth/verify", { code: wrong });
    failsWith(r, 400, "code_wrong");
    assert.equal(r.body.tries_left, left);
  }
  failsWith(await b.call("POST", "/auth/verify", { code: wrong }), 400, "code_dead");
  failsWith(await b.call("POST", "/auth/verify", { code }), 400, "code_dead", "the right code no longer works either");
  failsWith(await browser().call("POST", "/auth/verify/link", { token: linkIn(lastMail(email))[2] }), 400, "link_expired");
  refused(await b.call("GET", `/w/${ws.id}`));
  // A new code starts over.
  await age(email, "sent_at", 61);
  assert.equal((await b.call("POST", "/auth/verify/resend")).status, 200);
  assert.equal((await b.call("POST", "/auth/verify", { code: codeIn(lastMail(email)) })).status, 200);
});

test("codes and links expire after 30 minutes", async () => {
  const { b, email } = await signUp();
  const row = (await query("SELECT extract(epoch FROM expires_at - sent_at) AS s FROM email_verifications WHERE email = $1", [email])).rows[0];
  assert.equal(Number(row.s), 30 * 60);
  const mail = lastMail(email);
  await age(email, "expires_at", 30 * 60 + 1);
  failsWith(await b.call("POST", "/auth/verify", { code: codeIn(mail) }), 400, "code_expired");
  failsWith(await browser().call("POST", "/auth/verify/link", { token: linkIn(mail)[2] }), 400, "link_expired");
});

test("a new code waits a minute, says how long, replaces the old one, and sends stop for an hour after six", async () => {
  const { b, email } = await signUp();
  const first = lastMail(email);
  const early = await b.call("POST", "/auth/verify/resend");
  failsWith(early, 429, "resend_wait");
  assert.ok(early.body.retry_in > 0 && early.body.retry_in <= 60, String(early.body.retry_in));
  assert.equal(outbox.filter((m) => m.to === email).length, 1, "nothing sent while waiting");

  await age(email, "sent_at", 61);
  const again = await b.call("POST", "/auth/verify/resend");
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.email, email);
  assert.equal(again.body.resend_in, 60);
  const second = lastMail(email);
  assert.notEqual(second, first);
  if (codeIn(first) !== codeIn(second)) failsWith(await b.call("POST", "/auth/verify", { code: codeIn(first) }), 400, "code_wrong");
  failsWith(await browser().call("POST", "/auth/verify/link", { token: linkIn(first)[2] }), 400, "link_invalid", "the old link is replaced");
  assert.equal((await b.call("GET", "/auth/me")).body.verification.resend_in > 0, true);

  // Six emails an hour at most, whatever the wait between them.
  for (let i = 3; i <= 6; i++) {
    await age(email, "sent_at", 61);
    assert.equal((await b.call("POST", "/auth/verify/resend")).status, 200, `send ${i}`);
  }
  await age(email, "sent_at", 61);
  const capped = await b.call("POST", "/auth/verify/resend");
  failsWith(capped, 429, "resend_wait");
  assert.ok(capped.body.retry_in > 60 && capped.body.retry_in <= 3600, String(capped.body.retry_in));
  await age(email, "sends_since", 3601);
  await age(email, "sent_at", 61);
  assert.equal((await b.call("POST", "/auth/verify/resend")).status, 200, "a new hour, new sends");
  assert.equal((await b.call("POST", "/auth/verify", { code: codeIn(lastMail(email)) })).status, 200);
});

test("a typo in the address: change it, the new address gets a new code, the old one stops working", async () => {
  const { b, email, ws } = await signUp();
  const old = lastMail(email);
  const fixed = address("fixed");
  failsWith(await b.call("POST", "/auth/email", { email: "not an email" }), 400, undefined);
  const r = await b.call("POST", "/auth/email", { email: fixed });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.email, fixed);
  assert.equal(r.body.user.email_verified, false);
  assert.equal(r.body.verification.email, fixed);
  assert.equal((await b.call("GET", "/auth/me")).body.user.email, fixed);
  const mail = lastMail(fixed);
  assert.ok(codeIn(mail));
  failsWith(await browser().call("POST", "/auth/verify/link", { token: linkIn(old)[2] }), 400, "link_invalid");
  if (codeIn(old) !== codeIn(mail)) failsWith(await b.call("POST", "/auth/verify", { code: codeIn(old) }), 400, "code_wrong");
  assert.equal((await browser().call("POST", "/auth/login", { email, password: PASSWORD })).status, 401, "the old address is gone");

  // Someone else's address can't be taken (the same answer sign-up gives).
  const other = await owner();
  failsWith(await b.call("POST", "/auth/email", { email: other.user.email }), 409, "email_taken");
  assert.equal((await b.call("GET", "/auth/me")).body.user.email, fixed);

  assert.equal((await b.call("POST", "/auth/verify", { code: codeIn(mail) })).status, 200);
  assert.equal((await b.call("GET", `/w/${ws.id}`)).status, 200);
  // A confirmed address isn't changed here.
  failsWith(await b.call("POST", "/auth/email", { email: address() }), 409, "already_verified");
  assert.equal((await browser().call("POST", "/auth/email", { email: address() })).status, 401);
});

test("changing the address is limited like sending a new code", async () => {
  const { b } = await signUp();
  for (let i = 2; i <= 6; i++) assert.equal((await b.call("POST", "/auth/email", { email: address("typo") })).status, 200, `change ${i}`);
  failsWith(await b.call("POST", "/auth/email", { email: address("typo") }), 429, "resend_wait");
});

test("a teammate who joins from the emailed invitation is confirmed; so is accepting one while unconfirmed", async () => {
  const o = await owner();
  const invite = async (email) => (await o.b.call("POST", `/w/${o.ws.id}/invites`, { email })).body.link.split("/invite/")[1];
  const joined = await browser().call("POST", `/invites/${await invite(address("mate"))}/join`, { name: "Sherzod", password: PASSWORD });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  assert.equal(joined.body.user.email_verified, true);

  const { b, email } = await signUp();
  const accepted = await b.call("POST", `/invites/${await invite(email)}/accept`);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal((await b.call("GET", "/auth/me")).body.user.email_verified, true);
  assert.equal((await b.call("GET", `/w/${o.ws.id}`)).status, 200);
});

test("a password reset from the emailed link confirms the address, and the stranger who typed it is locked out", async () => {
  const { b, email, ws } = await signUp();
  await browser().call("POST", "/auth/password/forgot", { email });
  const token = lastMail(email).text.match(/#\/reset\/([A-Za-z0-9_-]+)/)[1];
  const fresh = browser();
  const r = await fresh.call("POST", "/auth/password/reset", { token, password: "a brand new passphrase" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.email_verified, true);
  assert.equal((await fresh.call("GET", `/w/${ws.id}`)).status, 200);
  assert.equal((await b.call("GET", "/auth/me")).status, 401);
});

test("public routes don't depend on the owner's email: widget, booking and shop pages, webhooks", async () => {
  const o = await owner();
  const w = `/w/${o.ws.id}`;
  const agent = (await o.b.call("POST", `${w}/agents`, { name: "Store Support" })).body;
  await o.b.call("POST", `${w}/agents/${agent.id}/publish`);
  await drainJobs();
  await query("UPDATE users SET email_verified_at = NULL WHERE id = $1", [o.user.id]);
  refused(await o.b.call("GET", w));
  const visitor = browser();
  assert.equal((await visitor.call("GET", `/widget/${agent.public_key}/config`)).status, 200);
  const chat = await visitor.call("POST", `/widget/${agent.public_key}/conversations`, { page: "/" });
  assert.equal(chat.status, 201, JSON.stringify(chat.body));
  assert.equal((await visitor.call("GET", "/public/crm/no-such-business")).status, 404);
  assert.notEqual((await visitor.call("POST", "/channels/telegram/00000000-0000-0000-0000-000000000000", {})).status, 403);
  assert.notEqual((await visitor.call("POST", "/billing/polar/webhook", {})).body?.code, "email_unverified");
});

const migrate = () => execFileSync("node", ["scripts/migrate.js", "--test"], { cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), ".."), env: process.env, stdio: "pipe" });

test("accounts from before confirmation existed stay confirmed; a new one is never confirmed by migrating again", async () => {
  const before = await owner("Old Timer", "Old Shop");
  // The database as it was before this change: no column yet.
  await query("ALTER TABLE users DROP COLUMN email_verified_at CASCADE");
  migrate();
  const was = (await query("SELECT email_verified_at, created_at FROM users WHERE id = $1", [before.user.id])).rows[0];
  assert.deepEqual(was.email_verified_at, was.created_at, "confirmed as of when it was made");
  assert.equal((await before.b.call("GET", `/w/${before.ws.id}`)).status, 200);

  const { b, email, ws } = await signUp();
  migrate();
  migrate();
  assert.equal((await query("SELECT email_verified_at FROM users WHERE email = $1", [email])).rows[0].email_verified_at, null);
  refused(await b.call("GET", `/w/${ws.id}`));
  assert.equal((await before.b.call("GET", `/w/${before.ws.id}`)).status, 200, "still confirmed after migrating twice");
});
