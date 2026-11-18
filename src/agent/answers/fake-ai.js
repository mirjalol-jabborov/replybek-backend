import { EMBEDDING_DIM } from "./models.js";

// ───── Deterministic stand-in for tests ─────
const STOP = new Set("a an and are can could do does for from have how i if in is it its me my of on or our please should the there this to was what when where which will with would you your about any get got just like need".split(" "));
const words = (s) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}$ ]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, ""));

function fakeVector(text) {
  const v = new Array(EMBEDDING_DIM).fill(0);
  for (const w of words(text)) {
    let h = 2166136261;
    for (const ch of w) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    v[h % EMBEDDING_DIM] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

// What the fake model treats as small talk, standing in for the real model's judgment.
const FAKE_SMALL_TALK = /^(hi|hello|thanks|thank you|salom|rahmat|привет|спасибо)[.!]?$/i;

export const fake = {
  minSimilarity: 0.15,
  strongSimilarity: 0.3,
  calls: { embed: 0, chat: 0, moderate: 0 },
  async embed(texts) {
    fake.calls.embed += 1;
    return texts.map(fakeVector);
  },
  async chatJSON({ system, user, meta }) {
    fake.calls.chat += 1;
    if (meta?.task === "answer") fake.lastAnswer = { system, user };
    if (meta?.task === "integration_plan") {
      const ambiguous = /auth data|ui level/i.test(meta.goal) && (!meta.access_mode || meta.access_mode === "auto");
      return { summary: "Prepare the documented actions for your business goal.", endpoint_ids: meta.endpoints.filter(e => e.supported).map(e => e.id), access_mode: ambiguous ? "unknown" : meta.access_mode && meta.access_mode !== "auto" ? meta.access_mode : "server", questions: ambiguous ? ["Does your app use browser cookies or supply a user token?"] : [], requirements: [] };
    }
    // Tests set fake.translationDelay (ms) to make visitors overlap, and fake.failTranslations to see the fallback.
    if (meta?.task === "translate_questions" || meta?.task === "translate_welcome") {
      fake.calls.translate = (fake.calls.translate || 0) + 1;
      if (fake.translationDelay) await new Promise((done) => setTimeout(done, fake.translationDelay));
      if (fake.failTranslations) throw new Error("Fixture AI failure");
      if (meta.task === "translate_welcome") return { text: `[${meta.language}] ${meta.text}`.slice(0, 500) };
      return { questions: meta.questions.map(q => `[${meta.language}] ${q}`.slice(0, 180)) };
    }
    if (meta?.task === "suggestions") {
      return { questions: meta.passages.slice(0, 3).map((p) => ({
        text: meta.language === "uz" ? `${(p.heading || p.content).slice(0, 85)} haqida ma’lumot bera olasizmi?` : meta.language === "ru" ? `Что нужно знать: ${(p.heading || p.content).slice(0, 85)}?` : `What should I know about ${(p.heading || p.content).slice(0, 85)}?`, source_id: p.id,
      })) };
    }
    if (meta?.task === "integration_draft") {
      // Deterministic fixture parser, used only under the explicit fake/test AI mode.
      const matches = meta.selected_endpoints?.length ? meta.selected_endpoints.map(e => [`${e.method} ${e.path}`, e.method, e.path]) : [...meta.documentation.matchAll(/\b(GET|POST|PUT|PATCH|DELETE) (\/[a-z0-9_/$.-]+)/gi)].slice(0, 10);
      if (!matches.length) return { integration: null, missing: ["Add API endpoint paths and examples."] };
      return { integration: { name: "Documentation API", mode: "server", base_url: meta.selected_endpoints?.[0]?.base || meta.documentation.match(/https?:\/\/[^\s"<>]+/)?.[0] || "", auth: { type: "api_key" }, tools: matches.map((m, i) => ({ name: `action_${i}`, description: `${m[1]} ${m[2]}`, kind: "read", input: { type: "object", properties: {} }, request: { method: m[1].toUpperCase(), path: m[2] } })) }, evidence: matches.map((m, i) => ({ name: `action_${i}`, quote: m[0] })), warnings: [], missing: [] };
    }
    if (meta?.task === "brand_from_docs") {
      // The first line that looks like a heading names the business, as a real model would find it.
      // A sentence or a question isn't a name; then, like the real model, it leaves the name out.
      const line = meta.text.split("\n").map((l) => l.replace(/^#.*$/, "").trim()).find((l) => l.length > 1) || "";
      const name = /^[^.?!:]{2,40}$/.test(line) && line.split(/\s+/).length <= 5 ? line : "";
      if (!name) return { name: "", language: "en", description: "", agent_name: "", welcome: "" };
      const uz = /\b(va|uchun|bilan|qanday)\b/i.test(meta.text);
      return uz
        ? { name, language: "uz", description: `${name} haqida`, agent_name: `${name} AI agenti`, welcome: `Assalomu alaykum! Men ${name} AI agentiman. Sizga qanday yordam bera olaman?` }
        : { name, language: "en", description: `About ${name}`, agent_name: `${name} AI agent`, welcome: `Hi! I'm the ${name} AI agent. How can I help?` };
    }
    if (meta?.task === "summary") {
      return { bullets: meta.messages.filter((m) => m.role === "visitor").slice(0, 3).map((m) => `Customer said: ${m.body.slice(0, 80)}`) };
    }
    if (meta?.task === "rewrite") return { queries: [], small_talk: FAKE_SMALL_TALK.test(meta.question.trim()) };
    if (meta?.task === "outcome") return { answer: meta.outcome.status === "done" ? "Done." : meta.outcome.status === "cancelled" ? "Cancelled." : `Failed: ${meta.outcome.error}` };
    // Tests set fake.answerDelay (ms) to write while an answer is still being written.
    if (fake.answerDelay) await new Promise((done) => setTimeout(done, fake.answerDelay));
    if (FAKE_SMALL_TALK.test(meta.question.trim())) return { status: "answered", answer: "Hello! How can I help?", citations: [] };
    const top = meta.passages[0];
    // Like the real model: passages that barely share words with the question don't answer it.
    const q = new Set(words(meta.question));
    if (top && [...q].filter((w) => words(top.content + " " + (top.heading || "")).includes(w)).length / Math.max(1, q.size) < 0.34) {
      return { status: "not_found", answer: "", citations: [] };
    }
    if (top && meta.question.includes("[cite-all]")) return { status: "answered", answer: top.content.split(/(?<=\.)\s/)[0], citations: meta.passages.map((_, i) => i + 1) };
    if (!top) {
      return /damag|torn|broken|wrong item/i.test(meta.question)
        ? { status: "handoff", answer: "I'm sorry about that. A teammate will review it and reply here.", citations: [] }
        : { status: "not_found", answer: "", citations: [] };
    }
    return { status: "answered", answer: top.content.split(/(?<=\.)\s/)[0], citations: [1] };
  },
  // Tests call a tool by writing "[tool:name {json args}]" in the question.
  async chatTools({ system, user, meta, run }) {
    fake.calls.chat += 1;
    const m = meta.question.match(/\[tool:([\w-]+)\s*(\{.*\})?\]/);
    if (!m) return fake.chatJSON({ system, user, meta });
    const output = await run(m[1], m[2] ? JSON.parse(m[2]) : {});
    if (output?.error) return { status: "answered", answer: `${m[1]}: ${output.message || output.error}`, citations: [] };
    if (output?.status === "waiting_for_customer") return { status: "answered", answer: "Please check the details and press Confirm.", citations: [] };
    return { status: "answered", answer: `${m[1]} → ${JSON.stringify(output).slice(0, 300)}`, citations: [] };
  },
  // A PNG's "Description" text chunk stands in for what a photo shows; other files get their name.
  async readFile({ name, type, data }) {
    fake.calls.read = (fake.calls.read || 0) + 1;
    const said = data.toString("latin1").match(/Description\0([\x20-\x7e]{1,500})/);
    if (said) return said[1];
    if (/unreadable/.test(name)) throw new Error("fake read failure");
    return `A ${type.startsWith("image/") ? "photo" : "scanned document"} named ${name}.`;
  },
  async moderate(text) {
    fake.calls.moderate += 1;
    return text.includes("[flag-me]");
  },
};
