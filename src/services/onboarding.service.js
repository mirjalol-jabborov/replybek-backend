import { query } from "../db.js";
import { HttpError } from "../lib/http.js";
import { normalizeUrl } from "../lib/safeFetch.js";
import { readBrand } from "../lib/brand.js";
import { previewSite } from "./site.service.js";
import { PLANS } from "./workspaces.service.js";

const WELCOME = {
  en: (name) => `Hi! I'm the ${name} AI agent. How can I help you today?`,
  ru: (name) => `Здравствуйте! Я ИИ-агент ${name}. Чем могу помочь?`,
  uz: (name) => `Assalomu alaykum! Men ${name} AI agentiman. Sizga qanday yordam bera olaman?`,
};
const AGENT_NAME = { en: (n) => `${n} AI agent`, ru: (n) => `ИИ-агент ${n}`, uz: (n) => `${n} AI agenti` };

/**
 * First step of onboarding: reads the business's site and proposes everything for its first agent
 * (names, welcome, logo, colour, and which pages to learn from). Nothing is saved here.
 */
export async function analyzeSite(workspace, input) {
  const url = normalizeUrl(input);
  let brand;
  try {
    brand = await readBrand(url.href);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const timedOut = /abort|timeout/i.test(`${e.name} ${e.message}`);
    throw new HttpError(400, timedOut ? "Your website took too long to respond. Check the address and try again." : e.status === 400 ? e.message : "We couldn't open that website. Check the address and try again.");
  }
  const site = await previewSite(brand.url, PLANS[workspace.plan].pages).catch(() => null);
  const lang = brand.language;
  return {
    ...brand,
    agent_name: AGENT_NAME[lang](brand.name).slice(0, 80),
    welcome: WELCOME[lang](brand.name).slice(0, 500),
    purpose: `Answers visitors' questions about ${brand.name} (${brand.host}) using its website.${brand.description ? ` About the business: ${brand.description}` : ""}`.slice(0, 500),
    site,
  };
}

/** Onboarding finished or skipped: the dashboard stops offering it. Also remembers the website. */
export async function completeOnboarding(workspace, website) {
  const { rows } = await query(
    "UPDATE workspaces SET settings = settings || '{\"onboarded\": true}'::jsonb, website = COALESCE(website, $2) WHERE id = $1 RETURNING settings",
    [workspace.id, website || null]
  );
  return { settings: rows[0].settings };
}
