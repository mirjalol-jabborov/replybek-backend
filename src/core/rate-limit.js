/**
 * A small in-memory request limiter (one server, so no shared store is needed).
 * `key(req)` says who is counted; over the limit the answer is 429 with Retry-After.
 */
export function rateLimit({ windowMs, max, key, message = "Too many requests. Try again in a minute." }) {
  const hits = new Map(); // who → { count, resetAt }
  setInterval(() => {
    const now = Date.now();
    for (const [who, entry] of hits) if (entry.resetAt <= now) hits.delete(who);
  }, windowMs).unref();

  return (req, res, next) => {
    const who = key(req);
    if (!who) return next();
    const now = Date.now();
    let entry = hits.get(who);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(who, entry);
    }
    entry.count += 1;
    if (entry.count <= max) return next();
    res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
    return res.status(429).json({ message });
  };
}

/** The caller's address: Cloudflare's header when the request came through it, else the socket's. */
export const clientIP = (req) => req.headers["cf-connecting-ip"] || req.ip;
