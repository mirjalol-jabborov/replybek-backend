import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * The few words Replybek itself puts in front of a customer on a messaging channel: the buttons
 * under a confirmation, and the reason a file was refused. Everything else a customer reads is
 * written by the agent in the customer's own language. The wording lives in
 * src/locales/channels.json so the code stays in one language and translators touch data only.
 */
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../locales/channels.json");
const STRINGS = JSON.parse(fs.readFileSync(file, "utf-8"));

export function text(language, key, params = {}) {
  const entry = STRINGS[key];
  if (!entry) throw new Error(`No channel text named ${key}.`);
  const value = entry[language] || entry.en;
  return value.replace(/\{(\w+)\}/g, (match, name) => (params[name] == null ? match : String(params[name])));
}
