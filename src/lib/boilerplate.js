/**
 * Removes text that repeats across a site's pages (menus, headers, footers, contact bars).
 * Site builders like Tilda don't mark navigation as <nav>, so the same menu ends up in every
 * page's text. Within each section (first path segment) with at least 3 pages, any line that
 * appears on half or more of the pages is dropped. Smaller sections use the whole site.
 */
export function stripBoilerplate(pages) {
  const lines = (t) => t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const sectionOf = (url) => new URL(url).pathname.split("/").filter(Boolean)[0] || "";
  const groups = new Map();
  for (const p of pages) groups.set(sectionOf(p.url), [...(groups.get(sectionOf(p.url)) || []), p]);
  const counted = (group) => {
    const freq = new Map();
    for (const p of group) for (const l of new Set(lines(p.text))) freq.set(l, (freq.get(l) || 0) + 1);
    return { freq, threshold: Math.max(3, Math.ceil(group.length * 0.5)) };
  };
  const global = pages.length >= 3 ? counted(pages) : null;
  const bySection = new Map([...groups].filter(([, g]) => g.length >= 3).map(([k, g]) => [k, counted(g)]));
  return pages.map((p) => {
    const stats = [bySection.get(sectionOf(p.url)), global].filter(Boolean);
    if (!stats.length) return p;
    const kept = lines(p.text).filter((l) => !stats.some((s) => (s.freq.get(l) || 0) >= s.threshold));
    return { ...p, text: kept.join("\n") };
  });
}
