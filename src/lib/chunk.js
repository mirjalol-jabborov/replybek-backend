/**
 * Splits sections into passages of about `size` characters on paragraph and sentence
 * boundaries, so each passage can be quoted on its own. Each passage keeps its heading.
 */
export function chunkSections(sections, { size = 900, max = 1400 } = {}) {
  const out = [];
  for (const { heading, text } of sections) {
    const paras = text.split(/\n{2,}|\n(?=[A-Z0-9•\-*])/).map((p) => p.trim()).filter(Boolean);
    let buf = "";
    const flush = () => {
      if (buf.trim()) out.push({ heading, content: buf.trim() });
      buf = "";
    };
    for (const para of paras) {
      const pieces = para.length > max ? para.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [para] : [para];
      for (const piece of pieces) {
        if (buf && buf.length + piece.length > size) flush();
        buf += (buf ? "\n" : "") + piece.trim();
        if (buf.length > max) flush();
      }
    }
    flush();
  }
  return out;
}

export const toVector = (arr) => `[${arr.join(",")}]`;
