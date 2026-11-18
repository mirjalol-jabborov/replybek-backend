/**
 * Customers often send a few messages in a row ("salom", "buyurtmam qayerda", "4127"), and an
 * album arrives as one message per photo. A chat's messages are handled one after another, and
 * the ones that arrive within BURST_MS of each other get a single answer that has read them all.
 */
// People often finish a thought in two or three messages ("I want flowers", "around 500k"). One
// answer waits until they pause for a moment, but never longer than the cap after the first.
const burstMs = () => Number(process.env.TELEGRAM_BURST_MS ?? 2000);
const burstCapMs = () => Number(process.env.TELEGRAM_BURST_CAP_MS ?? 4000);
const chats = new Map(); // "<channel>:<chat>" → { waiting, timer, chain, busy }

export function chatQueue(key) {
  let q = chats.get(key);
  if (!q) chats.set(key, (q = { waiting: [], timer: null, chain: Promise.resolve(), busy: 0 }));
  return q;
}

/** Runs `work` after everything already queued for this chat. */
export function inChat(key, work) {
  const q = chatQueue(key);
  q.busy++;
  q.chain = q.chain
    .then(work)
    .catch((e) => console.error(`Telegram chat ${key} failed:`, e.message))
    .finally(() => {
      if (--q.busy === 0 && !q.waiting.length && !q.timer) chats.delete(key);
    });
  return q.chain;
}

/** A message has come in for this chat; until it reaches `collect`, it waits behind the work queued there. */
export function arrived(key) {
  const q = chatQueue(key);
  q.incoming = (q.incoming || 0) + 1;
  return () => (q.incoming = Math.max(0, q.incoming - 1));
}

/** Holds a message briefly, so one answer covers the burst it belongs to. */
export function collect(key, message, handle) {
  const q = chatQueue(key);
  if (!q.waiting.length) q.firstAt = Date.now();
  q.waiting.push(message);
  clearTimeout(q.timer);
  q.timer = setTimeout(() => {
    q.timer = null;
    const batch = q.waiting.splice(0);
    q.queued = (q.queued || 0) + 1;
    inChat(key, () => {
      q.queued -= 1;
      return handle(batch);
    });
  }, Math.max(0, Math.min(burstMs(), q.firstAt + burstCapMs() - Date.now())));
}

/** True while newer messages from this chat wait their turn: an answer written before them is stale. */
export const moreWaiting = (key) => {
  const q = chats.get(key);
  return Boolean(q && (q.waiting.length || q.queued || q.incoming));
};
