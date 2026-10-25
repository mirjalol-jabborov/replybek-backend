// Checks the real OpenAI connection with the key in .env: one embedding, one moderation and one
// answer call (a fraction of a cent). Prints models, timings and results; never the key.
import "dotenv/config";
import { ai, models, isFake } from "../src/ai.js";

if (isFake()) {
  console.error("AI_FAKE or NODE_ENV=test is set; unset it to test the real API.");
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is not set in .env.");
  process.exit(1);
}
const time = async (label, fn) => {
  const t = Date.now();
  try {
    const out = await fn();
    console.log(`✔ ${label} (${Date.now() - t} ms)`);
    return out;
  } catch (e) {
    console.log(`✖ ${label}: ${e.status ? `HTTP ${e.status} ` : ""}${e.message}`);
    process.exitCode = 1;
    return null;
  }
};

const m = models();
console.log(`Models: chat=${m.chat}, embedding=${m.embedding}, moderation=${m.moderation}`);

const passages = [
  "Unworn items with the original tags attached can be returned within 30 days of delivery.",
  "Standard delivery takes 3–5 business days. Orders above $75 qualify for free standard shipping.",
  "Wash wool items by hand in cold water and lay them flat to dry.",
];
const question = "How long do I have to send something back?";
const vectors = await time("Embeddings", () => ai.embed([...passages, question]));
if (vectors) {
  const q = vectors.at(-1);
  const sims = vectors.slice(0, -1).map((v) => v.reduce((s, x, i) => s + x * q[i], 0));
  const best = sims.indexOf(Math.max(...sims));
  console.log(`  ${q.length} dimensions; best passage #${best + 1} (similarity ${sims[best].toFixed(2)}): ${best === 0 ? "correct" : "unexpected"}`);
}
const flagged = await time("Moderation", () => ai.moderate(question));
if (flagged !== null) console.log(`  flagged: ${flagged}`);
const out = await time("Answer (JSON)", () =>
  ai.chatJSON({
    system: 'You answer from the numbered passages only. Reply as JSON: {"status": "answered" | "not_found", "answer": "...", "citations": [n]}',
    user: `Passages:\n${passages.map((p, i) => `[${i + 1}] ${p}`).join("\n")}\n\nQuestion: ${question}`,
    maxTokens: 200,
  })
);
if (out) console.log(`  ${JSON.stringify(out)}`);
console.log(process.exitCode ? "\nSome checks failed (see above)." : "\nOpenAI connection works.");
