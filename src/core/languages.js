// Languages: reading them from headers and attributes, naming them for the model, and the set the
// chat widget speaks. The widget has built-in texts for each of WIDGET_LANGUAGES, and a business's
// greeting and suggested questions are translated into them automatically when the owner hasn't
// written their own (see translations.service.js). Keep this list in step with the widget's.
export const WIDGET_LANGUAGES = ["en", "uz", "ru", "es", "pt", "fr", "it", "de", "ja", "ko", "zh", "ar", "tr", "hi", "id", "pl"];

export const isWidgetLanguage = (code) => WIDGET_LANGUAGES.includes(code);

/**
 * The base language code of a tag or an Accept-Language value: "pt-BR" → "pt", "zh-Hans" → "zh",
 * "ja,en;q=0.9" → "ja". Anything that isn't a well-formed 2–3 letter code gives `fallback`.
 */
export function languageOf(value, fallback = "en") {
  const code = String(value ?? "").trim().toLowerCase().split(/[,;]/)[0].trim().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(code) ? code : fallback;
}

// Where a language is written in more than one script, the one to use.
const SCRIPT = { uz: "Latin script", zh: "Simplified characters" };
let names;

/** The language's English name for prompts: "Japanese", "Uzbek (Latin script)"; the code itself if unknown. */
export function languageName(code) {
  try {
    names ||= new Intl.DisplayNames(["en"], { type: "language" });
  } catch {
    names = null;
  }
  let name = code;
  try {
    name = names?.of(code) || code;
  } catch {
    // not a code Intl knows
  }
  return SCRIPT[code] ? `${name} (${SCRIPT[code]})` : name;
}
