import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { owner, browser, query } from "./helpers/setup.js";
import { fakeAI } from "../src/ai.js";
import { languageOf, languageName } from "../src/lib/languages.js";

afterEach(() => {
  fakeAI.failTranslations = false;
  fakeAI.translationDelay = 0;
});

test("languageOf reads tags and Accept-Language values, and refuses junk", () => {
  assert.equal(languageOf("ja"), "ja");
  assert.equal(languageOf("pt-BR"), "pt");
  assert.equal(languageOf("zh-Hans"), "zh");
  assert.equal(languageOf("pt_BR"), "pt");
  assert.equal(languageOf("ar,en;q=0.8"), "ar");
  assert.equal(languageOf("UZ"), "uz", "en, uz and ru as before");
  assert.equal(languageOf("ru-RU"), "ru");
  for (const junk of ["", "x", "12", "<script>", "toolong", null, undefined, "../../etc"]) assert.equal(languageOf(junk), "en", String(junk));
  assert.equal(languageOf("bad tag", null), null, "a caller can ask for no fallback");
  assert.equal(languageName("ja"), "Japanese");
  assert.equal(languageName("uz"), "Uzbek (Latin script)");
});

const QUESTIONS = ["Do you deliver?", "How do returns work?"];

async function publishedAgent() {
  const o = await owner();
  const w = `/w/${o.ws.id}`;
  const agent = (await o.b.call("POST", `${w}/agents`, { name: "Shop Help" })).body;
  const saved = await o.b.call("PATCH", `${w}/agents/${agent.id}`, { welcome: "Hi! How can I help?", suggested_questions_i18n: { en: QUESTIONS }, suggestion_default_language: "en" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  await o.b.call("POST", `${w}/agents/${agent.id}/publish`);
  const config = async (lang) => (await browser().call("GET", `/widget/${agent.public_key}/config?lang=${encodeURIComponent(lang)}`)).body;
  const row = async () => (await query("SELECT welcome_i18n, suggested_questions_i18n, auto_translations FROM agents WHERE id = $1", [agent.id])).rows[0];
  return { ...o, w, agent, path: `${w}/agents/${agent.id}`, config, row };
}

test("a visitor in another language gets the greeting and questions translated once, saved and marked", async () => {
  const s = await publishedAgent();
  const before = fakeAI.calls.translate || 0;
  const ja = await s.config("ja");
  assert.equal(ja.welcome, "[ja] Hi! How can I help?");
  assert.deepEqual(ja.suggestions, QUESTIONS.map((q) => `[ja] ${q}`));
  const row = await s.row();
  assert.equal(row.welcome_i18n.ja, "[ja] Hi! How can I help?");
  assert.deepEqual(row.suggested_questions_i18n.ja, ja.suggestions);
  assert.ok(row.auto_translations.welcome.ja.from && row.auto_translations.questions.ja.from, "marked as automatic");
  assert.equal(row.auto_translations.welcome.ja.pending, undefined, "the claim is released");
  await s.config("ja");
  assert.equal(fakeAI.calls.translate - before, 2, "translated once (greeting + questions), then read from the database");
  // The dashboard sees the mark with the agent.
  assert.ok((await s.b.call("GET", s.path)).body.auto_translations.welcome.ja);
});

test("the owner's own translations are used, the default language is never translated, and en/uz/ru behave as before", async () => {
  const s = await publishedAgent();
  await s.b.call("PATCH", s.path, { welcome_i18n: { uz: "Salom!", ru: "", es: "¡Hola!" }, suggested_questions_i18n: { en: QUESTIONS, uz: ["Yetkazib berasizmi?"], ru: [] } });
  const before = fakeAI.calls.translate || 0;
  assert.equal((await s.config("uz")).welcome, "Salom!");
  assert.deepEqual((await s.config("uz")).suggestions, ["Yetkazib berasizmi?"]);
  assert.equal((await s.config("ru")).welcome, "Hi! How can I help?", "an empty greeting means the main one");
  assert.deepEqual((await s.config("ru")).suggestions, [], "an empty list means none");
  assert.equal((await s.config("es")).welcome, "¡Hola!");
  assert.equal((await s.config("en")).welcome, "Hi! How can I help?");
  assert.deepEqual((await s.config("en-GB")).suggestions, QUESTIONS);
  assert.equal(fakeAI.calls.translate - before, 1, "only the missing Spanish questions were translated");
});

test("languages the widget doesn't speak, and junk, cost no AI call", async () => {
  const s = await publishedAgent();
  const before = fakeAI.calls.translate || 0;
  for (const lang of ["fil", "xx", "zz-ZZ", "<b>", "a".repeat(40)]) {
    const c = await s.config(lang);
    assert.equal(c.welcome, "Hi! How can I help?");
    assert.deepEqual(c.suggestions, QUESTIONS);
  }
  assert.equal(fakeAI.calls.translate - before, 0);
  assert.deepEqual((await s.row()).auto_translations, {});
});

test("when the AI fails the default texts come back, nothing is saved, and a later visitor can try again", async () => {
  const s = await publishedAgent();
  fakeAI.failTranslations = true;
  const c = await s.config("de");
  assert.equal(c.welcome, "Hi! How can I help?");
  assert.deepEqual(c.suggestions, QUESTIONS);
  const row = await s.row();
  assert.equal(row.welcome_i18n.de, undefined);
  assert.equal(row.auto_translations.welcome?.de?.pending, undefined, "the claim is released for a retry");
  fakeAI.failTranslations = false;
  assert.equal((await s.config("de")).welcome, "[de] Hi! How can I help?");
});

test("visitors arriving together cause one translation", async () => {
  const s = await publishedAgent();
  fakeAI.translationDelay = 250;
  const before = fakeAI.calls.translate || 0;
  const all = await Promise.all(Array.from({ length: 6 }, () => s.config("ko")));
  assert.equal(fakeAI.calls.translate - before, 2, "one greeting and one question translation for six visitors");
  for (const c of all) assert.equal(c.welcome, "[ko] Hi! How can I help?", "everyone waiting gets the translation");
  // Another process holding the claim: this one doesn't translate, it serves the default meanwhile.
  await query("UPDATE agents SET auto_translations = jsonb_build_object('welcome', jsonb_build_object('fr', jsonb_build_object('pending', now()))) WHERE id = $1", [s.agent.id]);
  const mid = fakeAI.calls.translate;
  assert.equal((await s.config("fr")).welcome, "Hi! How can I help?");
  assert.equal(fakeAI.calls.translate - mid, 1, "only the questions (not claimed) were translated");
});

test("an owner's edit is never overwritten; translations follow changes to the original", async () => {
  const s = await publishedAgent();
  await s.config("ja");
  const agent = (await s.b.call("GET", s.path)).body;
  // The owner corrects the Japanese greeting: it's theirs now.
  const edited = await s.b.call("PATCH", s.path, { welcome_i18n: { ...agent.welcome_i18n, ja: "こんにちは。" } });
  assert.equal(edited.body.auto_translations.welcome.ja, undefined, "no longer marked automatic");
  assert.ok(edited.body.auto_translations.questions.ja, "the untouched question list keeps its mark");
  // The original greeting changes: automatic translations are redone, the owner's stays.
  await s.b.call("PATCH", s.path, { welcome: "Hello there!", suggested_questions_i18n: { ...edited.body.suggested_questions_i18n, en: ["Where is my order?"] } });
  const ja = await s.config("ja");
  assert.equal(ja.welcome, "こんにちは。");
  assert.deepEqual(ja.suggestions, ["[ja] Where is my order?"], "the automatic question list followed the new original");
  // An owner's edit made while a translation runs wins over the translation.
  fakeAI.translationDelay = 300;
  const pending = s.config("it");
  await new Promise((d) => setTimeout(d, 100));
  const now = (await s.b.call("GET", s.path)).body;
  await s.b.call("PATCH", s.path, { welcome_i18n: { ...now.welcome_i18n, it: "Ciao!" } });
  await pending;
  assert.equal((await s.row()).welcome_i18n.it, "Ciao!");
  assert.equal((await s.config("it")).welcome, "Ciao!");
});

test("the page's language reaches the answer, for messages with no clear language", async () => {
  const s = await publishedAgent();
  const v = browser();
  const start = (await v.call("POST", `/widget/${s.agent.public_key}/conversations?lang=ar`, { language: "ar" })).body;
  assert.equal(start.config.welcome, "[ar] Hi! How can I help?", "the first config is in the page's language too");
  const say = (body) => v.call("POST", `/widget/${s.agent.public_key}/conversations/${start.conversation_id}/messages`, body, { "X-Visitor-Token": start.visitor_token });
  await say({ text: "👍", language: "ja-JP" });
  assert.match(fakeAI.lastAnswer.system, /no clear language of its own.*the page's language, Japanese/s);
  assert.match(fakeAI.lastAnswer.user, /Write "answer" in Japanese: the new message has no words of its own/, "a message without a letter gets the page's language outright");
  await say({ text: "Where is my order?", language: "ja" });
  assert.match(fakeAI.lastAnswer.user, /in the language of the customer's new message \(if it has no clear language of its own: Japanese\)/, "words decide for themselves");
  assert.equal((await query("SELECT visitor->>'language' AS l FROM conversations WHERE id = $1", [start.conversation_id])).rows[0].l, "ja", "kept for later answers");
  await say({ text: "4127", language: "<script>" });
  assert.match(fakeAI.lastAnswer.system, /Japanese/, "junk is ignored; the saved page language stays");
  assert.doesNotMatch(fakeAI.lastAnswer.system, /Uzbek, Russian and English|one of these three/);
});
