import dns from "dns/promises";
import net from "net";
import { HttpError } from "./http.js";

/**
 * Fetches a public web page for the knowledge crawler. Customers type these URLs, so the
 * crawler must never reach the server's own network (localhost, cloud metadata, private
 * ranges): every hop, including redirects, is resolved and checked first.
 */

const BLOCKED_V4 = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const v4num = (ip) => ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const n = v4num(ip);
    return BLOCKED_V4.some(([base, bits]) => (n >>> (32 - bits)) === (v4num(base) >>> (32 - bits)));
  }
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("::ffff:")) return isPrivate(lower.slice(7));
  return /^(fc|fd|fe8|fe9|fea|feb)/.test(lower);
}

const allowPrivate = () => process.env.ALLOW_PRIVATE_URLS === "true" && process.env.NODE_ENV !== "production";

export async function assertPublicHost(hostname) {
  if (allowPrivate()) return;
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => {
    throw new HttpError(400, `We couldn't find ${hostname}. Check the address.`);
  });
  if (addresses.some((a) => isPrivate(a.address))) {
    throw new HttpError(400, "That address points to a private network, which Replybek can't read.");
  }
}

export function normalizeUrl(input) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new HttpError(400, "Enter a valid web address, like example.com/help.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new HttpError(400, "Only http and https addresses can be added.");
  if (url.username || url.password) throw new HttpError(400, "Addresses with a username or password can't be added.");
  if (url.port && !["80", "443"].includes(url.port) && !allowPrivate()) throw new HttpError(400, "Only standard web ports (80 and 443) can be read.");
  url.hash = "";
  return url;
}

export const USER_AGENT = "ReplybekBot/0.1 (knowledge import)";

/**
 * GET with redirects checked hop by hop, a timeout and a size cap. Returns { url, status, type, body, truncated }.
 * With `truncate`, a bigger response is cut at `maxBytes` instead of refused (HTML pages heavy with inline
 * CSS or scripts still have their text, and their <head> comes first).
 */
export async function safeFetch(input, { maxBytes = 3 * 1024 * 1024, timeoutMs = 10000, truncate = false } = {}) {
  let url = normalizeUrl(String(input));
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicHost(url.hostname);
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain;q=0.9,*/*;q=0.5" } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = normalizeUrl(new URL(res.headers.get("location"), url).href);
      continue;
    }
    const chunks = [];
    let size = 0;
    let truncated = false;
    for await (const chunk of res.body || []) {
      if (size + chunk.length > maxBytes) {
        if (!truncate) throw new HttpError(400, `That page is larger than Replybek can import (${Math.round(maxBytes / 1024 / 1024) || 1} MB).`);
        chunks.push(chunk.subarray(0, maxBytes - size));
        truncated = true;
        break; // leaving the loop cancels the rest of the download
      }
      size += chunk.length;
      chunks.push(chunk);
    }
    return { url: url.href, status: res.status, type: res.headers.get("content-type") || "", body: Buffer.concat(chunks), truncated };
  }
  throw new HttpError(400, "That address redirects too many times.");
}
