// Sets up Polar billing: the three monthly products and the webhook, then writes their ids and the
// webhook secret to an env file. Safe to run again: existing products and endpoints are reused.
//
//   node scripts/polar-setup.js --webhook-url https://<tunnel>.trycloudflare.com      (sandbox, into .env)
//   node scripts/polar-setup.js --skip-webhook                                          (products only)
//   node scripts/polar-setup.js --production --webhook-url https://api.replybek.uz --out .env.production
//
// Reads POLAR_ACCESS_TOKEN from the env file it writes to. The token needs products:read/write and
// webhooks:read/write here, and checkouts:write, subscriptions:write, customer_sessions:write at runtime.
// Secrets are written to the file, never printed.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const production = process.argv.includes("--production");
const envFile = path.resolve(dir, "..", arg("--out") || ".env");
const env = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
const token = env.POLAR_ACCESS_TOKEN || process.env.POLAR_ACCESS_TOKEN;
const apiBase = arg("--api") || (production ? "https://api.polar.sh/v1" : "https://sandbox-api.polar.sh/v1");
const webhookBase = (arg("--webhook-url") || env.PUBLIC_API_URL || "").replace(/\/$/, "");
const skipWebhook = process.argv.includes("--skip-webhook");

if (!token) fail(`Put POLAR_ACCESS_TOKEN=… (a ${production ? "production" : "sandbox"} organization token) in ${path.basename(envFile)} first.`);
if (!skipWebhook && !/^https:\/\//.test(webhookBase)) fail("Polar needs a public https address for the webhook: pass --webhook-url https://… (or --skip-webhook to add it later)");

// Prices come from the dashboard's plan list, so Polar and the app can't drift apart.
const constants = fs.readFileSync(path.resolve(dir, "../../replybek-app/src/constants.js"), "utf8");
const PLANS = [...constants.matchAll(/\{ id: "(starter|growth|business)", name: "([^"]+)", price: (\d+)/g)].map(([, id, name, price]) => ({ id, name, price: Number(price) }));
if (PLANS.length !== 3) fail("Couldn't read the three plans from replybek-app/src/constants.js.");

const EVENTS = ["subscription.created", "subscription.updated", "subscription.active", "subscription.canceled", "subscription.uncanceled", "subscription.revoked", "subscription.past_due"];

async function call(method, p, body) {
  const res = await fetch(apiBase + p, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401 || res.status === 403) fail(`Polar refused the token (${res.status}) on ${method} ${p}. Check it's a ${production ? "production" : "sandbox"} token with the scopes listed at the top of this script.`);
  if (!res.ok) fail(`Polar ${method} ${p} failed (${res.status}): ${JSON.stringify(data).slice(0, 400)}`);
  return data;
}

const values = { POLAR_API_URL: apiBase };
const existing = (await call("GET", "/products/?is_archived=false&limit=100")).items || [];
for (const plan of PLANS) {
  const name = `Replybek ${plan.name}`;
  let product = existing.find((p) => p.name === name && p.recurring_interval === "month");
  if (product) {
    const price = product.prices?.find((x) => x.amount_type === "fixed" && !x.is_archived);
    if (price && price.price_amount !== plan.price * 100) {
      // Listing only the new price archives the old one. Existing subscribers keep what they signed up at.
      await call("PATCH", `/products/${product.id}`, { prices: [{ amount_type: "fixed", price_amount: plan.price * 100, price_currency: "usd" }] });
      console.log(`✓ ${name}: price changed from $${price.price_amount / 100} to $${plan.price}/month (new buyers only)`);
    } else {
      console.log(`✓ ${name}: already there`);
    }
  } else {
    product = await call("POST", "/products/", {
      name,
      recurring_interval: "month",
      prices: [{ amount_type: "fixed", price_amount: plan.price * 100, price_currency: "usd" }],
    });
    console.log(`✓ ${name}: created, $${plan.price}/month`);
  }
  values[`POLAR_PRODUCT_${plan.id.toUpperCase()}`] = product.id;
}

if (!skipWebhook) {
  const url = `${webhookBase}/billing/polar/webhook`;
  const endpoints = (await call("GET", "/webhooks/endpoints?limit=100")).items || [];
  let endpoint = endpoints.find((e) => e.url === url);
  if (endpoint && endpoint.secret) {
    console.log(`✓ Webhook ${url}: already there`);
  } else {
    endpoint = await call("POST", "/webhooks/endpoints", { url, name: "Replybek", format: "raw", events: EVENTS });
    console.log(`✓ Webhook ${url}: created`);
  }
  values.POLAR_WEBHOOK_SECRET = endpoint.secret;
}

writeEnv(envFile, values);
console.log(`\nWrote ${Object.keys(values).join(", ")} to ${path.basename(envFile)}. Restart the API to use them.`);

/** Sets each key in the env file, replacing an existing (or commented-out) line, else appending. */
function writeEnv(file, vals) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  for (const [key, value] of Object.entries(vals)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^#? ?${key}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  }
  fs.writeFileSync(file, text);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
