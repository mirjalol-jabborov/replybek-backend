// Messages from the CRM to a customer: what each one is, the words a business starts with, the
// placeholders it may use, and how a text is filled in. Pure, so the app's settings tab shows the
// same default texts and previews a text exactly as the customer will read it.
// settings.notices holds only what a business changed; noticeSettings() fills in the rest.

export const NOTICE_LANGUAGES = ["en", "ru", "uz"];

/**
 * The kinds of message, and the placeholders each one fills. `reminder` is switched by
 * settings.remindOn and timed by settings.remindBefore; `orderStep` goes out when an order enters
 * one of the steps the business ticked.
 */
const BOOKING = ["name", "day", "time", "service", "specialist", "business"];
const ORDER = ["name", "number", "total", "step", "day", "time", "business"];
export const NOTICE_KINDS = {
  booked: BOOKING,
  moved: BOOKING,
  cancelled: BOOKING,
  reminder: BOOKING,
  orderStep: ORDER,
  orderCancelled: ORDER,
};

/** The words a business starts with. Empty or missing texts in settings fall back to these. */
export const NOTICE_TEXTS = {
  booked: {
    en: "Hello, {name}. Your booking is confirmed: {service}, {day} at {time}.",
    ru: "Здравствуйте, {name}. Ваша запись подтверждена: {service}, {day} в {time}.",
    uz: "Assalomu alaykum, {name}. Broningiz tasdiqlandi: {service}, {day}, soat {time}.",
  },
  moved: {
    en: "{name}, your booking has moved: {service}, now {day} at {time}.",
    ru: "{name}, ваша запись перенесена: {service}, теперь {day} в {time}.",
    uz: "{name}, broningiz koʻchirildi: {service}, endi {day}, soat {time}.",
  },
  cancelled: {
    en: "{name}, your booking is cancelled: {service}, {day} at {time}.",
    ru: "{name}, ваша запись отменена: {service}, {day} в {time}.",
    uz: "{name}, broningiz bekor qilindi: {service}, {day}, soat {time}.",
  },
  reminder: {
    en: "{name}, a reminder of your booking: {service}, {day} at {time}.",
    ru: "{name}, напоминаем о записи: {service}, {day} в {time}.",
    uz: "{name}, broningizni eslatamiz: {service}, {day}, soat {time}.",
  },
  orderStep: {
    en: "{name}, your order №{number} is now: {step}.",
    ru: "{name}, ваш заказ №{number}: {step}.",
    uz: "{name}, №{number} buyurtmangiz holati: {step}.",
  },
  orderCancelled: {
    en: "{name}, your order №{number} is cancelled.",
    ru: "{name}, ваш заказ №{number} отменён.",
    uz: "{name}, №{number} buyurtmangiz bekor qilindi.",
  },
};

const PLACEHOLDER = /\{([a-zA-Z]+)\}/g;

/** Placeholders a text uses that its kind doesn't fill: ["number"]. Empty when the text is fine. */
export function unknownPlaceholders(kind, text) {
  const known = NOTICE_KINDS[kind] || [];
  return [...new Set([...String(text).matchAll(PLACEHOLDER)].map((m) => m[1]).filter((p) => !known.includes(p)))];
}

/**
 * Whether a text has a brace that isn't part of a whole placeholder ("{ name }", "{name_1}",
 * "{{name}}", "{name"): render() would leave it in the text the customer reads.
 */
export const strayBraces = (text) => /[{}]/.test(String(text).replace(PLACEHOLDER, ""));

/** A text with its placeholders filled: render("Hi, {name}.", { name: "Aziz" }). Unknown ones are left out. */
export function render(text, values) {
  return String(text)
    .replace(PLACEHOLDER, (_, key) => (values[key] == null ? "" : String(values[key])))
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * settings.notices with every switch and text filled in:
 * { language, booked: { on, text: { en, ru, uz } }, ..., reminder: { on, text }, orderStep: { on, text, steps } }.
 * `settings` is the whole settings object: the reminder's switch is settings.remindOn.
 */
export function noticeSettings(settings = {}) {
  const saved = settings.notices || {};
  const out = { language: NOTICE_LANGUAGES.includes(saved.language) ? saved.language : "uz" };
  for (const kind of Object.keys(NOTICE_KINDS)) {
    const mine = saved[kind] || {};
    const text = Object.fromEntries(NOTICE_LANGUAGES.map((l) => [l, mine.text?.[l] || NOTICE_TEXTS[kind][l]]));
    out[kind] = { on: kind === "reminder" ? settings.remindOn !== false : mine.on !== false, text };
  }
  out.orderStep.steps = saved.orderStep?.steps || [];
  return out;
}

/** The language a message goes out in: the customer's when it is one we write in, else the business's. */
export const noticeLanguage = (customerLanguage, fallback) => (NOTICE_LANGUAGES.includes(customerLanguage) ? customerLanguage : fallback);

/* ───── How days, times and sums read in a message ───── */

const MONTHS = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  ru: ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"],
  uz: ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"],
};
const WEEKDAYS = {
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  ru: ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"],
  uz: ["yakshanba", "dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba"],
};

/** "2026-11-19" → "Thursday, 19 November" · "четверг, 19 ноября" · "19-noyabr, payshanba". */
export function dayText(day, language) {
  if (!day) return "";
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  const wd = WEEKDAYS[language][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const month = MONTHS[language][m - 1];
  if (language === "uz") return `${d}-${month}, ${wd}`;
  return `${wd}, ${d} ${month}`;
}

const CURRENCY = { en: "soʻm", ru: "сум", uz: "soʻm" };
/** 1250000 → "1 250 000 soʻm" (сум in Russian). */
export const moneyText = (n, language) => `${String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} ${CURRENCY[language]}`;

/** A name from a settings list or a row: what someone typed, or { en, ru, uz }. */
export const nameIn = (name, language) => (typeof name === "string" ? name : name?.[language] || name?.en || Object.values(name || {}).find(Boolean) || "");
