import OpenAI from "openai";
import { HttpError } from "./lib/http.js";

/**
 * Everything Replybek asks of a model goes through `ai`: embeddings for knowledge search,
 * JSON chat for answers and summaries, and moderation. Tests (NODE_ENV=test or AI_FAKE=true)
 * get a deterministic stand-in that needs no key and costs nothing.
 */

export const EMBEDDING_DIM = 1536;
export const models = () => ({
  chat: process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini",
  embedding: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
  moderation: process.env.OPENAI_MODERATION_MODEL || "omni-moderation-latest",
});

let client;
function openai() {
  if (!process.env.OPENAI_API_KEY) throw new HttpError(503, "AI answers aren't configured on this server yet.");
  client ||= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30000, maxRetries: 2 });
  return client;
}

const real = {
  // Cosine similarity below this means a passage is probably unrelated to the question.
  minSimilarity: Number(process.env.RETRIEVAL_MIN_SIMILARITY || 0.3),
  // Below this, the best match is weak enough to try reworded (and translated) searches.
  strongSimilarity: Number(process.env.RETRIEVAL_STRONG_SIMILARITY || 0.45),

  async embed(texts) {
    const out = [];
    for (let i = 0; i < texts.length; i += 96) {
      const res = await openai().embeddings.create({ model: models().embedding, input: texts.slice(i, i + 96) });
      out.push(...res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding));
    }
    return out;
  },

  async chatJSON({ system, user, maxTokens = 700 }) {
    const res = await openai().chat.completions.create({
      model: models().chat,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: maxTokens,
    });
    const content = res.choices[0]?.message?.content || "{}";
    try {
      return JSON.parse(content);
    } catch {
      throw new Error("The model returned text that isn't JSON.");
    }
  },

  /**
   * JSON chat where the model may call tools first. `run(name, args)` executes one call and
   * returns what the model sees. After `maxSteps` rounds the model must answer.
   */
  async chatTools({ system, user, tools, run, maxTokens = 700, maxSteps = 4 }) {
    const messages = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    const defs = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    for (let step = 0; ; step++) {
      const res = await openai().chat.completions.create({
        model: models().chat,
        messages,
        tools: defs,
        tool_choice: step < maxSteps ? "auto" : "none",
        response_format: { type: "json_object" },
        max_completion_tokens: maxTokens,
      });
      const msg = res.choices[0]?.message;
      if (!msg?.tool_calls?.length) {
        try {
          return JSON.parse(msg?.content || "{}");
        } catch {
          throw new Error("The model returned text that isn't JSON.");
        }
      }
      messages.push({ role: "assistant", content: msg.content || null, tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          // A malformed call gets an error back instead of crashing the answer.
        }
        const output = await run(call.function.name, args);
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output).slice(0, 12000) });
      }
    }
  },

  /** True when OpenAI's moderation flags the text. */
  async moderate(text) {
    const res = await openai().moderations.create({ model: models().moderation, input: text });
    return Boolean(res.results[0]?.flagged);
  },
};

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

const fake = {
  minSimilarity: 0.15,
  strongSimilarity: 0.3,
  calls: { embed: 0, chat: 0, moderate: 0 },
  async embed(texts) {
    fake.calls.embed += 1;
    return texts.map(fakeVector);
  },
  async chatJSON({ meta }) {
    fake.calls.chat += 1;
    if (meta?.task === "summary") {
      return { bullets: meta.messages.filter((m) => m.role === "visitor").slice(0, 3).map((m) => `Customer said: ${m.body.slice(0, 80)}`) };
    }
    if (meta?.task === "rewrite") return { queries: [] };
    if (meta?.task === "outcome") return { answer: meta.outcome.status === "done" ? "Done." : meta.outcome.status === "cancelled" ? "Cancelled." : `Failed: ${meta.outcome.error}` };
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
  async chatTools({ meta, run }) {
    fake.calls.chat += 1;
    const m = meta.question.match(/\[tool:([\w-]+)\s*(\{.*\})?\]/);
    if (!m) return fake.chatJSON({ meta });
    const output = await run(m[1], m[2] ? JSON.parse(m[2]) : {});
    if (output?.error) return { status: "answered", answer: `${m[1]}: ${output.message || output.error}`, citations: [] };
    if (output?.status === "waiting_for_customer") return { status: "answered", answer: "Please check the details and press Confirm.", citations: [] };
    return { status: "answered", answer: `${m[1]} → ${JSON.stringify(output).slice(0, 300)}`, citations: [] };
  },
  async moderate(text) {
    fake.calls.moderate += 1;
    return text.includes("[flag-me]");
  },
};

export const isFake = () => process.env.AI_FAKE === "true" || process.env.NODE_ENV === "test";
export const ai = new Proxy({}, { get: (_, key) => (isFake() ? fake : real)[key] });
export const fakeAI = fake;
