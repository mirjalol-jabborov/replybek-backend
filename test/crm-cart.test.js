// The cart in a chat (src/bridge/cart.js): a product card's "Add to cart" with how many, the
// agent's cart tools, an order from the cart, and a website that takes the tap into its own cart.
import assert from "node:assert/strict";
import { test } from "node:test";
import { owner, browser, query } from "./helpers/setup.js";
import { crmTools, runCrmTool, decideCrmAction } from "../src/bridge/crm-tools.js";
import { photoKeyboard } from "../src/agent/inbox/delivery.js";
import { fakeAI } from "../src/agent/answers/ai.js";

const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const names = (entries) => entries.map((e) => e.tool.name).sort();

async function shop(store = "act") {
  const o = await owner("Dilnoza Rahimova", "Gulzor");
  const w = `/w/${o.ws.id}`;
  const agent = ok(await o.b.call("POST", `${w}/agents`, { name: "Gulzor AI" }), 201);
  ok(await o.b.call("POST", `${w}/agents/${agent.id}/publish`));
  const row = (await query("SELECT * FROM agents WHERE id = $1", [agent.id])).rows[0];
  ok(await o.b.call("POST", `${w}/products`, { add: "crm" }));
  ok(await o.b.call("PUT", `${w}/crm/settings`, { modules: { booking: false, store: true }, settings: { ai: { agentId: agent.id, channels: { widget: true, telegram: true }, booking: "off", store } } }));
  const post = async (path, body) => ok(await o.b.call("POST", `${w}/crm${path}`, body), 201);
  const peony = (await post("/products", { name: "Peony bouquet", price: 150000, opening: 5 })).id;
  const box = (await post("/products", { name: "Gift box", options: [{ id: "size", name: "Size", values: ["S", "M"] }], variants: [{ values: { size: "S" }, price: 40000, opening: 3 }, { values: { size: "M" }, price: 45000, opening: 3 }] })).id;
  const tulips = (await post("/products", { name: "Tulips", price: 1000, opening: 30 })).id;
  const variants = (await o.b.call("GET", `${w}/crm/snapshot?only=products`)).body.products;
  const v = (id) => variants.find((p) => p.id === id).variants;
  return { o, w, agent, row, key: agent.public_key, peony, box, tulips, peonyV: v(peony)[0].id, boxV: v(box) };
}

async function chat(s) {
  const v = browser();
  const start = ok(await v.call("POST", `/widget/${s.key}/conversations`, {}), 201);
  const vt = { "X-Visitor-Token": start.visitor_token };
  const path = `/widget/${s.key}/conversations/${start.conversation_id}`;
  const say = async (text) => ok(await v.call("POST", `${path}/messages`, { text }, vt)).messages.at(-1);
  return {
    cid: start.conversation_id,
    say,
    tool: (name, args = {}) => say(`[tool:${name} ${JSON.stringify(args)}]`),
    tap: (mid, n, body = {}) => v.call("POST", `${path}/messages/${mid}/cards/${n}/action`, body, vt),
    decide: (id) => v.call("POST", `${path}/actions/${id}/confirm`, {}, vt),
    run: (name, args = {}) => runCrmTool({ agent: s.row, conversationId: start.conversation_id, tool: { name }, args }).then((r) => r.output),
  };
}
const cardOf = async (cid, mid) => (await query("SELECT card FROM messages WHERE id = $1 AND conversation_id = $2", [mid, cid])).rows[0].card;

test("a product card has a quantity and Add to cart; a tap puts that many in the chat's cart in one step", async () => {
  const s = await shop();
  const c = await chat(s);
  const shown = await c.tool("crm_find_products", { search: "peony" });
  const { action, items } = shown.card;
  assert.deepEqual([action.crm, action.tool, action.quantity, action.max, action.integration_id], [true, "crm_add_to_cart", "qty", 10, null]);
  assert.deepEqual(action.label, { en: "Add to cart", ru: "В корзину", uz: "Savatga" });
  assert.deepEqual(action.done, { en: "In cart", ru: "В корзине", uz: "Savatda" });
  assert.deepEqual(items[0].args, { product: s.peony, variant: s.peonyV });

  const tapped = ok(await c.tap(shown.id, 0, { qty: 2 }));
  assert.equal(tapped.messages.at(-1).body, "Done.", "the AI says what happened, no Confirm card");
  assert.equal(tapped.messages.at(-1).card, null);
  assert.deepEqual((await cardOf(c.cid, shown.id)).taps["0"], { status: "done", qty: 2, where: "chat" });
  assert.equal((await c.tap(shown.id, 0, { qty: 1 })).status, 409, "once per card");
  const cart = await c.run("crm_cart");
  assert.deepEqual([cart.count, cart.total, cart.totalText], [2, 300000, "300 000 soʻm"]);
  assert.deepEqual(cart.lines.map((l) => [l.name, l.qty, l.sumText]), [["Peony bouquet", 2, "300 000 soʻm"]]);

  // The next answer knows the tap, and which cart it went to.
  await c.say("what is in my cart?");
  assert.match(fakeAI.lastAnswer.user, /tapped "Add to cart": 1\) Peony bouquet × 2 into this chat's cart/);
});

test("the cart keeps the Store's rules: at most 10 of a thing, what is left, on sale, an option when there are several", async () => {
  const s = await shop();
  const c = await chat(s);
  assert.equal((await c.run("crm_add_to_cart", { product: s.tulips, qty: 6 })).inCart, 6);
  assert.deepEqual(await c.run("crm_add_to_cart", { product: s.tulips, qty: 5 }), { error: "too_many", product: s.tulips, variant: (await c.run("crm_cart")).lines[0].variant, max: 10, inCart: 6 });
  assert.equal((await c.run("crm_add_to_cart", { product: s.tulips, qty: 11 })).error, "bad_input");
  assert.deepEqual(await c.run("crm_add_to_cart", { product: s.peony, qty: 6 }), { error: "short", product: s.peony, variant: s.peonyV, left: 5, inCart: 0 });
  assert.equal((await c.run("crm_add_to_cart", { product: s.box, qty: 1 })).error, "variant_required");
  assert.equal((await c.run("crm_add_to_cart", { product: s.box, variant: s.boxV[1].id, qty: 1 })).option, "M");
  assert.equal((await c.run("crm_update_cart", { variant: s.boxV[1].id, qty: 3 })).inCart, 3);
  assert.equal((await c.run("crm_update_cart", { variant: s.boxV[1].id, qty: 0 })).status, "removed");

  // Off sale after it went in: the cart says so and it isn't counted.
  await c.run("crm_add_to_cart", { product: s.peony, qty: 1 });
  ok(await s.o.b.call("PUT", `${s.w}/crm/products/${s.peony}`, { onSale: false }));
  const cart = await c.run("crm_cart");
  assert.deepEqual(cart.lines.map((l) => [l.name, l.problem || null]), [["Tulips", null], ["Peony bouquet", "off_sale"]]);
  assert.equal(cart.total, 6000);
  assert.deepEqual(await c.run("crm_add_to_cart", { product: s.peony, qty: 1 }), { error: "off_sale", product: s.peony });

  // A card for a product with options: no option on its button, so a tap asks which one.
  const shown = await c.tool("crm_find_products", { search: "gift" });
  assert.deepEqual(shown.card.items[0].args, { product: s.box });
  const asked = ok(await c.tap(shown.id, 0, { qty: 1 }));
  assert.match(asked.messages.at(-1).body, /variant_required/);
  assert.equal((await cardOf(c.cid, shown.id)).taps["0"], undefined, "the button can be tapped again");
});

test("an order from the cart: no lines orders what is in it, and Confirm empties it", async () => {
  const s = await shop();
  const c = await chat(s);
  await c.run("crm_identify_customer", { phone: "+998901112233", name: "Aziza" });
  assert.deepEqual((await runCrmTool({ agent: s.row, conversationId: c.cid, tool: { name: "crm_place_order" }, args: { delivery: { method: "pickup" } } })).output, { error: "cart_empty" });
  const shown = await c.tool("crm_find_products", { search: "peony" });
  ok(await c.tap(shown.id, 0, { qty: 2 }));
  await c.run("crm_add_to_cart", { product: s.tulips, qty: 3 });
  const proposal = await c.tool("crm_place_order", { delivery: { method: "pickup" } });
  assert.deepEqual(proposal.card.lines.slice(0, 2), [["Peony bouquet × 2", "300 000 soʻm"], ["Tulips × 3", "3 000 soʻm"]]);
  assert.equal((await c.run("crm_cart")).count, 5, "nothing leaves the cart before Confirm");
  assert.equal(ok(await c.decide(proposal.card.action_id)).messages.at(-1).body, "Done.");
  const [order] = (await s.o.b.call("GET", `${s.w}/crm/snapshot?only=orders`)).body.orders;
  assert.deepEqual(order.lines.map((l) => l.qty), [2, 3]);
  assert.equal((await c.run("crm_cart")).count, 0);
});

test("a website with its own cart takes the tap: set in the CRM, told to the widget, the chat records where it went", async () => {
  const s = await shop();
  const c = await chat(s);
  const ai = (cart) => s.o.b.call("PUT", `${s.w}/crm/settings`, { settings: { ai: { agentId: s.agent.id, channels: { widget: true, telegram: true }, booking: "off", store: "act", ...(cart ? { cart } : {}) } } });
  const config = async () => ok(await browser().call("GET", `/widget/${s.key}/config`)).cart;
  assert.equal(await config(), undefined, "the chat's cart unless the CRM says otherwise");
  // The widget's word alone doesn't put it in the website's cart.
  const early = await c.tool("crm_find_products", { search: "peony" });
  assert.match(ok(await c.tap(early.id, 0, { qty: 1, placed: "site" })).messages.at(-1).body, /unavailable/);
  assert.equal((await ai({ mode: "site", url: "" })).status, 400, "an address is needed");
  assert.equal((await ai({ mode: "site", url: "http://shop.example/cart" })).status, 400, "https only, except localhost");
  ok(await ai({ mode: "site", url: "http://localhost:4302/api/cart" }));
  assert.deepEqual(await config(), { url: "http://localhost:4302/api/cart" });
  ok(await ai({ mode: "site", url: "https://shop.example/api/cart" }));
  assert.deepEqual(await config(), { url: "https://shop.example/api/cart" });

  const shown = await c.tool("crm_find_products", { search: "peony" });
  ok(await c.tap(shown.id, 0, { qty: 2, placed: "site" }));
  assert.deepEqual((await cardOf(c.cid, shown.id)).taps["0"], { status: "done", qty: 2, where: "site" });
  assert.equal((await c.run("crm_cart")).count, 0);
  await c.say("thanks");
  assert.match(fakeAI.lastAnswer.user, /Peony bouquet × 2 into the website's own cart/);
  // The site refused it (more than 10 of one bouquet): failed, and the button can be tapped again.
  const again = await c.tool("crm_find_products", { search: "tulips" });
  assert.match(ok(await c.tap(again.id, 0, { qty: 3, placed: "site", refused: "too_many" })).messages.at(-1).body, /too_many/);
  assert.equal((await cardOf(c.cid, again.id)).taps["0"].status, "failed");
});

test("at the answer level there are no cart tools and no button; Telegram's photo gets Add to cart, then − N +", async () => {
  const s = await shop("answer");
  assert.deepEqual(names(await crmTools(s.row)), ["crm_find_products", "crm_identify_customer", "crm_my_orders", "crm_order_options"]);
  const c = await chat(s);
  const shown = await c.tool("crm_find_products", { search: "peony" });
  assert.equal(shown.card.action, undefined);
  assert.equal(shown.card.items[0].args, undefined);
  assert.equal((await c.tap(shown.id, 0, { qty: 1 })).status, 404);
  assert.deepEqual(await c.run("crm_add_to_cart", { product: s.peony, qty: 1 }), { error: "unavailable" });

  const message = { id: "11111111-2222-3333-4444-555555555555", card: { type: "products", action: { crm: true, label: { en: "Add to cart", uz: "Savatga" }, done: { en: "In cart", uz: "Savatda" } }, items: [{ title: "Peony", args: { product: s.peony }, url: "https://shop.example/p" }] } };
  assert.deepEqual(photoKeyboard(message, 0, "uz"), [[{ text: "Savatga", callback_data: `cart:${message.id}:0:add` }], [{ text: "Batafsil", url: "https://shop.example/p" }]]);
  assert.deepEqual(photoKeyboard(message, 0, "uz", 2)[0].map((b) => b.text), ["−", "Savatda: 2", "+"]);
  assert.equal(photoKeyboard({ id: message.id, card: { ...message.card, action: undefined } }, 0, "uz").length, 1, "an integration's card keeps only its link");
});

test("Telegram: a tap on Add to cart under a photo puts one in the cart, + and − change it", async () => {
  const s = await shop();
  const { rows } = await query("INSERT INTO conversations (workspace_id, agent_id, channel, visitor, visitor_token_hash) VALUES ($1, $2, 'widget', '{}', 'x') RETURNING id", [s.o.ws.id, s.agent.id]);
  const { tapCrmButton, stepCrmButton } = await import("../src/agent/inbox/chat.js");
  const conv = (await query("SELECT * FROM conversations WHERE id = $1", [rows[0].id])).rows[0];
  const out = await runCrmTool({ agent: s.row, conversationId: conv.id, tool: { name: "crm_find_products" }, args: { search: "peony" } });
  const { displayCard } = await import("../src/agent/integrations/cards.js");
  const tool = (await crmTools(s.row, conv.id)).find((t) => t.tool.name === "crm_find_products").tool;
  const card = displayCard(tool.display, out.output, { crm: true });
  const id = (await query("INSERT INTO messages (conversation_id, workspace_id, role, body, card) VALUES ($1, $2, 'ai', 'x', $3) RETURNING id", [conv.id, s.o.ws.id, card])).rows[0].id;
  const msg = { id, card };
  assert.equal((await tapCrmButton(s.agent, conv, msg, 0, { qty: 1 })).result.inCart, 1);
  assert.deepEqual(await stepCrmButton(s.agent, conv, msg, 0, 1), { qty: 2 });
  assert.deepEqual(await stepCrmButton(s.agent, conv, msg, 0, -1), { qty: 1 });
  assert.deepEqual(await stepCrmButton(s.agent, conv, msg, 0, -1), { qty: 0 });
  assert.equal((await cardOf(conv.id, id)).taps["0"], undefined);
  assert.deepEqual(await stepCrmButton(s.agent, conv, msg, 0, 1), { qty: 1 });
  await query("UPDATE crm_bridge_cart SET qty = 10 WHERE conversation_id = $1", [conv.id]);
  assert.deepEqual(await stepCrmButton(s.agent, conv, msg, 0, 1), { qty: 10, error: "too_many", max: 10 });
});
