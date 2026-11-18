// What a write answers with, so the app can update its copy without asking again:
// { set: { orders: [row] }, del: { movements: [id] }, top: { tags: [...] } }.
// `set`: rows to insert or replace by id; `del`: rows to drop; `top`: whole top-level keys to replace.

/** Joins several changes into one. A row set twice keeps its last version. */
export function mergeChanges(...parts) {
  const out = {};
  for (const part of parts) {
    if (!part) continue;
    for (const [key, rows] of Object.entries(part.set || {})) {
      const byId = new Map((out.set?.[key] || []).map((r) => [r.id, r]));
      for (const r of rows) byId.set(r.id, r);
      (out.set ||= {})[key] = [...byId.values()];
    }
    for (const [key, ids] of Object.entries(part.del || {})) (out.del ||= {})[key] = [...new Set([...(out.del?.[key] || []), ...ids])];
    if (part.top) out.top = { ...out.top, ...part.top };
  }
  return out;
}
