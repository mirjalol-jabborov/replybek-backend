// Rules about the customer themselves, wherever they act on their own (the public pages, the AI
// agent in a chat): how their Telegram handle is kept, what a refusal may tell them, and how much
// one of them may make in a day.

/**
 * A Telegram handle as the CRM keeps it, bare: "@Jasur_K", "t.me/jasur_k" and
 * "https://t.me/jasur_k" all become "Jasur_K". Anything else comes back trimmed, as typed.
 * Handles are compared without regard to letter case, as Telegram does.
 */
export const telegramHandle = (raw) =>
  String(raw ?? "")
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?(t\.me|telegram\.me)\//i, "")
    .replace(/^@+/, "")
    .replace(/\/+$/, "");

// The numbers a reason may carry to a customer. Everything else (another booking's id or times,
// a specialist's or the business's own notes, stock counts) stays inside.
const SAFE = ["minutes", "days", "step", "weekday", "maxDays", "prepMinutes", "earliest", "time", "date", "variantId", "productId", "left", "field", "max"];
/** A reason as a customer may see it: its code and only the harmless numbers. */
export const forCustomer = (reason) => Object.fromEntries(Object.entries(reason || {}).filter(([k]) => k === "code" || SAFE.includes(k)));

/**
 * How many bookings, and how many orders, one customer may make themselves in a business day,
 * on the pages and through the AI agent together. Ones that were called off don't count.
 */
export const PER_PHONE_PER_DAY = 3;
