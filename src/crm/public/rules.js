// The public pages' own rule, as a pure function: which addresses a page may have. The rules
// customers meet on a page (cancelling, the delivery time, what a refusal may say, how many are
// left) are the modules' own, in ../shared, and the AI agent meets the same ones.

/* ───── The address ───── */

/** 3 to 40 lowercase letters, digits and single hyphens, starting and ending with a letter or digit. */
export const SLUG = /^(?=.{3,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Names that would read as Replybek's own pages, or are likely to be wanted for them later. */
const RESERVED_SLUGS = [
  "about", "account", "admin", "api", "app", "assets", "billing", "blog", "book", "booking", "cabinet", "crm", "dashboard",
  "docs", "help", "home", "info", "login", "logout", "mail", "new", "order", "orders", "pay", "pricing", "privacy",
  "public", "register", "replybek", "settings", "shop", "signin", "signup", "static", "status", "store", "support",
  "terms", "test", "widget", "www",
];
/** Why a page's address can't be used: { code: "bad_slug" | "reserved_slug" }, or null. "" means no address yet. */
export function slugProblem(slug) {
  if (slug === "") return null;
  if (typeof slug !== "string" || !SLUG.test(slug)) return { code: "bad_slug" };
  if (RESERVED_SLUGS.includes(slug)) return { code: "reserved_slug" };
  return null;
}
