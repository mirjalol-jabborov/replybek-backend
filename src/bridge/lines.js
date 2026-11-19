// What a customer asks for in a chat, line by line, checked against the Store as customers see
// it: on sale, the option chosen when there are several, at most LEFT_CAP of one thing, and no more
// than is left. Shared by the cart in the chat (cart.js) and a new order (store.js), so both refuse
// with the same codes.
import * as storeModule from "../crm/store/index.js";
import { capped, optionsText, qtyByVariant, tooMany } from "../crm/shared/store.js";

/** A variant's options as words: "M, Red". */
export const optionText = (p, v) => optionsText(p.options, v.values);
/** The variants a customer can order now: something is left of them. */
export const orderable = (p) => p.variants.filter((v) => v.left > 0);

/**
 * `asked`: [{ product, variant?, qty }]. Answers { lines: [{ productId, variantId, qty, price,
 * name, option, left }] } or a refusal: not_found, off_sale, variant_required (with the options),
 * too_many (max), short (left).
 */
export async function resolveLines(q, cfg, asked) {
  const onSale = await storeModule.productsForCustomers(q, cfg, [...new Set(asked.map((l) => l.product))]);
  const lines = [];
  for (const a of asked) {
    const p = onSale.find((x) => x.id === a.product);
    if (!p) return { error: (await storeModule.listProducts(q, cfg, [a.product])).length ? "off_sale" : "not_found", product: a.product };
    const choices = orderable(p);
    const v = a.variant ? p.variants.find((x) => x.id === a.variant) : choices.length === 1 ? choices[0] : null;
    if (!v && !a.variant && choices.length > 1) return { error: "variant_required", product: p.id, variants: choices.map((x) => ({ variant: x.id, option: optionText(p, x) })) };
    if (!v) return { error: "off_sale", product: p.id };
    lines.push({ productId: p.id, variantId: v.id, qty: a.qty, price: v.price, name: p.name, option: optionText(p, v), left: v.left });
  }
  // The Store's cap on one customer order comes before the stock, so no answer tells more than LEFT_CAP.
  const [over] = tooMany(lines);
  if (over) return { error: "too_many", product: over.productId, variant: over.variantId, max: over.max };
  const need = qtyByVariant(lines);
  const short = lines.find((l) => need[l.variantId] > l.left);
  if (short) return { error: "short", product: short.productId, variant: short.variantId, left: capped(short.left) };
  return { lines };
}
