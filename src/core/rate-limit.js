import net from "node:net";

/**
 * A small in-memory request limiter (one server, so no shared store is needed).
 * `key(req)` says who is counted; over the limit the answer is 429 with Retry-After, and
 * { message, code? } (`code` for callers that speak in codes, like the public pages).
 */
export function rateLimit({ windowMs, max, key, message = "Too many requests. Try again in a minute.", code }) {
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
    return res.status(429).json({ message, ...(code ? { code } : {}) });
  };
}

// Cloudflare's published addresses (https://www.cloudflare.com/ips/, checked 2026-11-19).
const CLOUDFLARE = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
  "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
];
const cloudflare = new net.BlockList();
for (const range of CLOUDFLARE) {
  const [addr, bits] = range.split("/");
  cloudflare.addSubnet(addr, Number(bits), addr.includes(":") ? "ipv6" : "ipv4");
}
const plain = (ip) => String(ip || "").replace(/^::ffff:/, "");
export const fromCloudflare = (ip) => {
  const a = plain(ip);
  const type = net.isIPv4(a) ? "ipv4" : net.isIPv6(a) ? "ipv6" : null;
  return !!type && cloudflare.check(a, type);
};

// This machine and the private network (other containers, like a shop site calling the API for its
// customer). Requests through Caddy never arrive with such an address: req.ip is what Caddy saw.
const local = new net.BlockList();
for (const [a, b] of [["127.0.0.0", 8], ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16]]) local.addSubnet(a, b, "ipv4");
for (const [a, b] of [["::1", 128], ["fc00::", 7]]) local.addSubnet(a, b, "ipv6");
const nearby = (ip) => {
  const type = net.isIPv4(ip) ? "ipv4" : net.isIPv6(ip) ? "ipv6" : null;
  return !!type && local.check(ip, type);
};

/**
 * The caller's address. Cloudflare's CF-Connecting-IP is believed only when the request really came
 * from a Cloudflare address, or from this machine or its private network (a local proxy, another
 * container, the tests); anyone calling the
 * server directly could write that header themselves. Behind Caddy, req.ip is the address Caddy saw.
 */
export const clientIP = (req) => {
  const peer = plain(req.ip);
  const cf = req.headers["cf-connecting-ip"];
  return cf && (fromCloudflare(peer) || nearby(peer)) ? plain(cf) : peer;
};
