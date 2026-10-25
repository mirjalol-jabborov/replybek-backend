import crypto from "crypto";

/**
 * Encrypts secrets at rest (OAuth client secrets, customers' access tokens) with AES-256-GCM.
 * The key comes from SECRET_KEY; development and tests fall back to a fixed key so they run
 * without setup, and production refuses to start without one.
 */
let key;
function secretKey() {
  if (key) return key;
  const raw = process.env.SECRET_KEY;
  if (!raw && process.env.NODE_ENV === "production") throw new Error("Set SECRET_KEY in production.");
  key = crypto.createHash("sha256").update(raw || "replybek-development-key").digest();
  return key;
}

export function encrypt(text) {
  if (text == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const data = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function decrypt(value) {
  if (!value) return null;
  const [version, iv, tag, data] = value.split(".");
  if (version !== "v1") throw new Error("Unknown secret format.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

/** A short-lived signed value (the OAuth `state`), so the callback can trust what it carries. */
export function sign(payload, ttlSeconds = 600) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlSeconds * 1000 })).toString("base64url");
  const mac = crypto.createHmac("sha256", secretKey()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verify(token) {
  const [body, mac] = String(token || "").split(".");
  if (!body || !mac) return null;
  const expected = crypto.createHmac("sha256", secretKey()).update(body).digest("base64url");
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  return payload.exp > Date.now() ? payload : null;
}
