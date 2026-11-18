// What Replybek sells: packages, each giving one or both products, each in tiers. The catalogue is
// data; the outside prices and the Polar product ids are configuration (written by
// scripts/polar-setup.js), so nothing here knows a price.
//
//   POLAR_PRODUCT_<PACKAGE>_<TIER>   the Polar product of one offer (the AI agent's also reads the
//                                    names from before packages: POLAR_PRODUCT_<TIER>)
//   POLAR_PRICE_<PACKAGE>_<TIER>     its price in the currency's smallest unit (whole number)
//   POLAR_CURRENCY                   usd unless set
//   TRIAL_DAYS_AGENT, TRIAL_DAYS_CRM each product's free trial, 7 days unless set
//   CRM_BILLING=on                   bills the CRM; until then it is free and open
import { polarEnabled } from "./polar.js";
import { isPaid } from "../workspaces/workspaces.js";

// A tier is the workspace's plan (workspaces.plan); the AI agent's limits per tier are PLANS in workspaces.js.
export const TIERS = ["starter", "growth", "business"];

// `name` goes into the Polar product's name ("Replybek CRM Growth"); `env` lists the names its ids
// are read from, first one first.
export const PACKAGES = [
  { key: "agent", products: ["agent"], tiers: TIERS, name: "", env: ["POLAR_PRODUCT_AGENT", "POLAR_PRODUCT"] },
  { key: "crm", products: ["crm"], tiers: TIERS, name: "CRM", env: ["POLAR_PRODUCT_CRM"] },
  { key: "both", products: ["agent", "crm"], tiers: TIERS, name: "AI agent + CRM", env: ["POLAR_PRODUCT_BOTH"] },
];
export const PACKAGE_KEYS = PACKAGES.map((p) => p.key);
const BY_KEY = Object.fromEntries(PACKAGES.map((p) => [p.key, p]));
export const packageOf = (key) => BY_KEY[key] || null;

// `switch`: the setting that turns billing on for a product once Polar is on; without one it is
// billed whenever Polar is.
const PRODUCT_BILLING = {
  agent: { trialEnv: "TRIAL_DAYS_AGENT" },
  crm: { trialEnv: "TRIAL_DAYS_CRM", switch: "CRM_BILLING" },
};

/** Whether a product is paid for. A product that isn't is free: everything in it is allowed. */
export function billed(product) {
  const cfg = PRODUCT_BILLING[product];
  return polarEnabled() && Boolean(cfg) && (!cfg.switch || process.env[cfg.switch] === "on");
}

/** The free trial a product gives, in days. */
function trialDays(product) {
  const raw = process.env[PRODUCT_BILLING[product]?.trialEnv];
  return raw != null && /^\d+$/.test(raw.trim()) ? Number(raw) : 7;
}

const envName = (prefix, tier) => `${prefix}_${tier.toUpperCase()}`;

/** The Polar product of one offer, or null while it isn't set up. */
export function polarProductFor(pkg, tier) {
  for (const prefix of pkg.env) {
    const id = process.env[envName(prefix, tier)];
    if (id) return id;
  }
  return null;
}

/** Which offer a Polar product is: { pkg, tier }, or null for a product that isn't ours. */
export function offerForPolarProduct(productId) {
  if (!productId) return null;
  for (const pkg of PACKAGES) {
    for (const tier of pkg.tiers) if (polarProductFor(pkg, tier) === productId) return { pkg, tier };
  }
  return null;
}

/** The outside price of one offer: { amount (smallest unit, whole), currency }, or null while none is set. */
function priceOf(pkg, tier) {
  const raw = process.env[envName(`POLAR_PRICE_${pkg.key.toUpperCase()}`, tier)];
  if (raw == null || !/^\d+$/.test(raw.trim())) return null;
  return { amount: Number(raw), currency: (process.env.POLAR_CURRENCY || "usd").toLowerCase() };
}

/** The catalogue as the app reads it. */
export const catalogue = () =>
  PACKAGES.map((pkg) => ({
    key: pkg.key,
    products: pkg.products,
    // A package with a product that is free right now isn't sold.
    sold: pkg.products.every(billed),
    tiers: pkg.tiers.map((tier) => ({ tier, price: priceOf(pkg, tier), ready: Boolean(polarProductFor(pkg, tier)) })),
  }));

/** The smallest package that gives every one of these products. */
function packageFor(products) {
  const fits = PACKAGES.filter((p) => products.every((x) => p.products.includes(x)));
  return fits.sort((a, b) => a.products.length - b.products.length)[0] || null;
}

// Before packages, every subscription was the AI agent's.
export const packageOfWorkspace = (workspace) => packageOf(workspace.billing_package) || BY_KEY.agent;

/**
 * What a workspace has once a package is live: the package's products, plus the ones it had that
 * the package before (`before`, null when there was none) didn't give: a free CRM, or a product
 * added before its billing was turned on, stays (read-only while unpaid). Only a product a
 * package gave goes when the next package doesn't. Products keep their order; new ones go last.
 */
export function productsAfter(current, pkg, before = null) {
  const kept = current.filter((p) => pkg.products.includes(p) || !billed(p) || !before?.products.includes(p));
  return [...kept, ...pkg.products.filter((p) => !kept.includes(p))];
}

/** The products a workspace has that are billed: what its package has to give. */
const billedProducts = (workspace) => (workspace.products || []).filter(billed);

/**
 * The trial a new subscription to this package gets. Polar's trial covers the whole subscription,
 * so each product's trial being given once means: none when any billed product in the package was
 * tried already, otherwise the longest of theirs. A running subscription changes package in place,
 * with no trial.
 */
export function checkoutTrialDays(workspace, pkg) {
  if (workspace.polar_subscription_id && isPaid(workspace.subscription_status)) return 0;
  const tried = workspace.trial_products || [];
  const here = pkg.products.filter(billed);
  if (here.some((p) => tried.includes(p))) return 0;
  return Math.max(0, ...here.map(trialDays));
}

/**
 * What the owner would buy to have `product` too (or, with none, to keep what they have): the
 * package of the billed products they have plus that one, in the tier they are on.
 */
export function offerFor(workspace, product = null) {
  const wanted = billedProducts(workspace);
  if (product && !wanted.includes(product)) wanted.push(product);
  const pkg = packageFor(wanted.length ? wanted : packageOfWorkspace(workspace).products);
  if (!pkg) return null;
  const tier = pkg.tiers.includes(workspace.plan) ? workspace.plan : pkg.tiers[0];
  return { package: pkg.key, tier, trial_days: checkoutTrialDays(workspace, pkg) };
}
