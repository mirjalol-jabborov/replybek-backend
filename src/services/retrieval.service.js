import { query } from "../db.js";
import { ai } from "../ai.js";
import { toVector } from "../lib/chunk.js";

// Words too common to help a keyword search (English, Uzbek, Russian).
const STOP = new Set(
  (
    "the and for are you your can how what when where which with does have this that from about there their our not any " +
    "va bilan uchun qanday qanaqa nima nimaga bu shu ham mumkin kerak qilib qilish bormi yoki emas edi bor " +
    "как что это для или при где когда можно нужно есть мне вас ваш почему какой какие"
  ).split(" ")
);
const APOSTROPHES = /['’‘ʻʼ`´]/g;

/**
 * A Postgres tsquery that matches any of the meaningful words, by prefix, so Uzbek and Russian
 * word endings still match ("yaratish" finds "yaratiladi"). Returns null when nothing is left.
 */
export function keywordQuery(text) {
  const words = (text.toLowerCase().replace(APOSTROPHES, "").match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length >= 3 && !STOP.has(w));
  // Long words are cut to a stem (Uzbek and Russian add endings: yaratiladi → yarati*, matches yaratish).
  const terms = [...new Set(words.map((w) => (w.length > 5 ? w.slice(0, Math.max(5, w.length - 4)) : w)))].slice(0, 12);
  return terms.length ? terms.map((t) => `${t}:*`).join(" | ") : null;
}

/**
 * Hybrid search over one agent's ready passages: nearest embeddings and keyword matches,
 * merged with reciprocal rank fusion. Each row has `similarity` (cosine) and `keyword` (rank or null).
 */
export async function searchKnowledge(agentId, vector, keywords, limit = 8) {
  const { rows } = await query(
    `WITH v AS (
        SELECT c.id, 1 - (c.embedding <=> $2::vector) AS sim, row_number() OVER (ORDER BY c.embedding <=> $2::vector) AS r
          FROM chunks c JOIN sources s ON s.id = c.source_id
         WHERE c.agent_id = $1 AND s.status = 'ready'
         ORDER BY c.embedding <=> $2::vector LIMIT 20),
      k AS (
        SELECT c.id, ts_rank_cd(c.search_tsv, q) AS rank, row_number() OVER (ORDER BY ts_rank_cd(c.search_tsv, q) DESC) AS r
          FROM chunks c JOIN sources s ON s.id = c.source_id, to_tsquery('simple', $3) q
         WHERE $3::text IS NOT NULL AND c.agent_id = $1 AND s.status = 'ready' AND c.search_tsv @@ q
         ORDER BY rank DESC LIMIT 20),
      f AS (
        SELECT id, sum(1.0 / (60 + r)) AS score, max(sim) AS sim, max(rank) AS kw
          FROM (SELECT id, r, sim, NULL::real AS rank FROM v UNION ALL SELECT id, r, NULL, rank FROM k) x
         GROUP BY id)
     SELECT c.id, c.source_id, c.heading, c.content, c.url, s.name AS source_name,
            COALESCE(f.sim, 1 - (c.embedding <=> $2::vector)) AS similarity, f.kw AS keyword, f.score
       FROM f JOIN chunks c ON c.id = f.id JOIN sources s ON s.id = c.source_id
      ORDER BY f.score DESC LIMIT $4`,
    [agentId, toVector(vector), keywords, limit]
  );
  return rows;
}

const hasKnowledge = async (agentId) => (await query("SELECT 1 FROM chunks WHERE agent_id = $1 LIMIT 1", [agentId])).rowCount > 0;

/**
 * Finds the passages to answer from. If the first search is weak, or the message is a follow-up
 * ("and for Canada?"), the model writes up to two better search queries (including one in the
 * other language, for sites with Uzbek and Russian docs) and those results are merged in.
 */
export async function retrieve(agent, question, history = []) {
  if (!(await hasKnowledge(agent.id))) return [];
  const [vector] = await ai.embed([question]);
  const found = new Map();
  const add = (rows) => {
    for (const r of rows) {
      const prev = found.get(r.id);
      found.set(r.id, prev ? { ...prev, similarity: Math.max(prev.similarity, r.similarity), keyword: prev.keyword ?? r.keyword, score: prev.score + Number(r.score) } : { ...r, score: Number(r.score) });
    }
  };
  add(await searchKnowledge(agent.id, vector, keywordQuery(question)));

  const strong = [...found.values()].some((r) => r.similarity >= ai.strongSimilarity);
  if (!strong || history.length) {
    const recent = history.slice(-4).map((m) => `${m.role === "visitor" ? "Customer" : "Assistant"}: ${m.body}`).join("\n");
    const out = await ai
      .chatJSON({
        system:
          'You write search queries for a help-center search. Rewrite the customer\'s latest message as up to 2 short, self-contained queries (resolve "it", "that", "and for…" from the conversation). If the message is in Uzbek, make one query Russian; if Russian, make one Uzbek; if English, keep English. Reply as JSON: {"queries": ["..."]}',
        user: `${recent ? `Conversation:\n${recent}\n\n` : ""}Latest message: ${question}`,
        maxTokens: 120,
        meta: { task: "rewrite", question },
      })
      .catch(() => ({ queries: [] }));
    const queries = (Array.isArray(out.queries) ? out.queries : []).map(String).filter((q) => q.trim() && q.trim() !== question.trim()).slice(0, 2);
    if (queries.length) {
      const vectors = await ai.embed(queries);
      for (let i = 0; i < queries.length; i++) add(await searchKnowledge(agent.id, vectors[i], keywordQuery(queries[i])));
    }
  }

  // Keep clearly similar passages, and keyword matches that are at least somewhat similar.
  return [...found.values()]
    .filter((r) => r.similarity >= ai.minSimilarity || (r.keyword != null && r.similarity >= ai.minSimilarity * 0.6))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}
