import crypto from "crypto";

/**
 * Polar billing. Off unless POLAR_ACCESS_TOKEN is set; then plans change only through Polar.
 * Each of our plans maps to one Polar product: POLAR_PRODUCT_STARTER, POLAR_PRODUCT_GROWTH, POLAR_PRODUCT_BUSINESS.
 */
const PLAN_IDS = ["starter", "growth", "business"];
const apiBase = () => (process.env.POLAR_API_URL || "https://api.polar.sh/v1").replace(/\/$/, "");

export const polarEnabled = () => Boolean(process.env.POLAR_ACCESS_TOKEN);
export const polarProductId = (plan) => process.env[`POLAR_PRODUCT_${plan.toUpperCase()}`] || null;
export const planForPolarProduct = (productId) => PLAN_IDS.find((p) => productId && polarProductId(p) === productId) || null;

async function call(method, path, body) {
  const res = await fetch(apiBase() + path, {
    method,
    headers: { Authorization: `Bearer ${process.env.POLAR_ACCESS_TOKEN}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw Object.assign(new Error(`Polar ${method} ${path} failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`), { status: res.status, expose: false });
  return data;
}

/**
 * A checkout session for one product. The workspace is the Polar customer (`external_customer_id`), so every
 * subscription and the customer portal find their way back to it. `metadata` is copied onto the subscription.
 * `trialDays` gives a free trial (card required); 0 turns the product's own trial off. Returns { id, url }.
 */
export async function createCheckout({ productId, externalCustomerId, email, metadata, successUrl, returnUrl, trialDays = 0 }) {
  const trial = trialDays > 0 ? { allow_trial: true, trial_interval: "day", trial_interval_count: trialDays } : { allow_trial: false };
  const body = { products: [productId], external_customer_id: externalCustomerId, customer_email: email || undefined, metadata, success_url: successUrl, return_url: returnUrl, ...trial };
  let c;
  try {
    c = await call("POST", "/checkouts/", body);
  } catch (e) {
    // Polar refuses addresses it can't deliver to (e.g. *.local); the customer then types one on the checkout page.
    if (!(e.status === 422 && body.customer_email && /customer_email/.test(e.message))) throw e;
    c = await call("POST", "/checkouts/", { ...body, customer_email: undefined });
  }
  return { id: c.id, url: c.url };
}

/** Moves a running subscription to another product; Polar prorates by the organization's default. */
export const changeProduct = (id, productId) => call("PATCH", `/subscriptions/${encodeURIComponent(id)}`, { product_id: productId });

/** Stops renewals; the customer keeps what they already paid for until the period ends. */
export const cancelAtPeriodEnd = (id) => call("PATCH", `/subscriptions/${encodeURIComponent(id)}`, { cancel_at_period_end: true });

/** A short-lived, signed-in link to Polar's customer portal (card, invoices, cancel). */
export async function portalUrl(externalCustomerId, returnUrl) {
  const s = await call("POST", "/customer-sessions/", { external_customer_id: externalCustomerId, return_url: returnUrl });
  return s.customer_portal_url;
}

/**
 * Standard Webhooks check: the signature is base64 HMAC-SHA256 over "{webhook-id}.{webhook-timestamp}.{raw body}".
 * Polar's secrets made since September 2026 are standard (`whsec_` + base64 key); older ones are keyed with the
 * secret's own bytes. Both are tried, as Polar's SDK does. Deliveries older or newer than 5 minutes are refused.
 */
export function verifyWebhook(raw, headers, secret = process.env.POLAR_WEBHOOK_SECRET, now = Date.now()) {
  const id = headers["webhook-id"];
  const ts = headers["webhook-timestamp"];
  const sig = headers["webhook-signature"];
  if (!secret || !id || !ts || !sig || !/^\d+$/.test(ts)) return false;
  if (Math.abs(now / 1000 - Number(ts)) > 300) return false;
  const expected = webhookKeys(secret).map((key) => crypto.createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest());
  // The header can carry several space-separated "v1,<sig>" entries while a secret is rotated.
  return sig.split(" ").some((entry) => {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) return false;
    const got = Buffer.from(value, "base64");
    return expected.some((e) => got.length === e.length && crypto.timingSafeEqual(got, e));
  });
}

function webhookKeys(secret) {
  const keys = [Buffer.from(secret, "utf8")];
  if (secret.startsWith("whsec_")) keys.unshift(Buffer.from(secret.slice("whsec_".length), "base64"));
  return keys;
}

/** Signs a payload the way Polar does. Used by tests. */
export function signWebhook(raw, { id, secret, timestamp = Math.floor(Date.now() / 1000) }) {
  const sig = crypto.createHmac("sha256", webhookKeys(secret)[0]).update(`${id}.${timestamp}.${raw}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": `v1,${sig}` };
}
