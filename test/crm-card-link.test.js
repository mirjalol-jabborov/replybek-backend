// A CRM product card's link (settings.ai.productUrl, src/bridge/store.js productLink): the
// business's own product page address with {id} or {sku}, else the CRM's shop page when it is
// open, else none. The widget opens it; Telegram puts it on a "Batafsil" button under the photo.
import assert from "node:assert/strict";
import { test } from "node:test";
import { owner, browser, query } from "./helpers/setup.js";
import { runCrmTool } from "../src/bridge/crm-tools.js";
import { photoKeyboard, productPhotos } from "../src/agent/inbox/delivery.js";
import { productUrlOk, fillProductUrl } from "../src/crm/core/ai-link.js";

const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const PAGE = { booking: false, shop: true, description: { en: "", ru: "", uz: "" }, phone: "", address: "", languages: ["uz", "ru", "en"], paymentMethods: ["cash"], deliveryMethods: ["pickup"] };

async function shop(store = "act") {
  const o = await owner("Dilnoza Rahimova", "Gulzor");
  const w = `/w/${o.ws.id}`;
  const agent = ok(await o.b.call("POST", `${w}/agents`, { name: "Gulzor AI" }), 201);
  ok(await o.b.call("POST", `${w}/agents/${agent.id}/publish`));
  const row = (await query("SELECT * FROM agents WHERE id = $1", [agent.id])).rows[0];
  ok(await o.b.call("POST", `${w}/products`, { add: "crm" }));
  const base = { agentId: agent.id, channels: { widget: true, telegram: true }, booking: "off", store };
  const ai = (more = {}) => o.b.call("PUT", `${w}/crm/settings`, { settings: { ai: { ...base, ...more } } });
  ok(await o.b.call("PUT", `${w}/crm/settings`, { modules: { booking: false, store: true } }));
  ok(await ai());
  const post = async (path, body) => ok(await o.b.call("POST", `${w}/crm${path}`, body), 201);
  const peony = (await post("/products", { name: "Peony bouquet", sku: "PB-7", price: 150000, opening: 5 })).id;
  const tulips = (await post("/products", { name: "Tulips", price: 1000, opening: 30 })).id;
  const v = browser();
  const start = ok(await v.call("POST", `/widget/${agent.public_key}/conversations`, {}), 201);
  const vt = { "X-Visitor-Token": start.visitor_token };
  const say = async (text) => ok(await v.call("POST", `/widget/${agent.public_key}/conversations/${start.conversation_id}/messages`, { text }, vt)).messages.at(-1);
  return {
    o, w, ai, peony, tulips,
    settings: async () => ok(await o.b.call("GET", `${w}/crm/snapshot?only=settings`)).settings.ai,
    page: (page) => o.b.call("PUT", `${w}/crm/settings`, { settings: { publicPage: { ...PAGE, ...page } } }),
    find: async (search) => (await runCrmTool({ agent: row, conversationId: start.conversation_id, tool: { name: "crm_find_products" }, args: { search } })).output.products,
    card: async (search) => (await say(`[tool:crm_find_products ${JSON.stringify({ search })}]`)).card,
  };
}

test("the address is checked: https (http on localhost), at most 300 characters, with {id} or {sku}", async () => {
  assert.equal(productUrlOk("https://shop.uz/product/{id}"), true);
  assert.equal(productUrlOk("https://shop.uz/p?sku={sku}"), true);
  assert.equal(productUrlOk("http://localhost:4000/product/{id}"), true);
  assert.equal(productUrlOk("http://shop.uz/product/{id}"), false);
  assert.equal(productUrlOk("https://shop.uz/product"), false);
  assert.equal(productUrlOk("javascript:alert({id})"), false);
  assert.equal(productUrlOk(`https://shop.uz/${"a".repeat(290)}/{id}`), false);
  assert.equal(fillProductUrl("https://shop.uz/product/{id}?s={sku}", { id: "a b/c", sku: "X-1" }), "https://shop.uz/product/a%20b%2Fc?s=X-1");
  assert.equal(fillProductUrl("https://shop.uz/p/{sku}", { id: "p1", sku: "" }), null, "no sku, no address");

  const s = await shop();
  assert.equal((await s.settings()).productUrl, undefined, "rows from before have none");
  for (const bad of ["http://shop.example/product/{id}", "https://shop.example/product", `https://shop.example/${"a".repeat(300)}{id}`]) {
    const r = await s.ai({ productUrl: bad });
    assert.equal(r.status, 400, bad);
  }
  ok(await s.ai({ productUrl: "  https://shop.example/product/{id}  " }));
  assert.equal((await s.settings()).productUrl, "https://shop.example/product/{id}");
  ok(await s.ai({ productUrl: "" }));
  assert.equal((await s.settings()).productUrl, undefined, "cleared");
});

test("a card opens the business's own product page: the address filled in, also for the model", async () => {
  const s = await shop();
  ok(await s.ai({ productUrl: "https://shop.example/product/{id}" }));
  const [p] = await s.find("peony");
  assert.equal(p.url, `https://shop.example/product/${s.peony}`);
  const card = await s.card("peony");
  assert.equal(card.items[0].url, `https://shop.example/product/${s.peony}`);
  assert.equal(productPhotos({ ...card, items: [{ ...card.items[0], image: "https://cdn.example/peony.jpg" }] })[0].link, card.items[0].url);

  // {sku}: a product without one falls back like a product without an address.
  ok(await s.ai({ productUrl: "https://shop.example/p/{sku}" }));
  assert.equal((await s.find("peony"))[0].url, "https://shop.example/p/PB-7");
  assert.equal((await s.find("tulips"))[0].url, undefined);
});

test("without an address: the CRM's shop page when it is open, else no link", async () => {
  const s = await shop();
  assert.equal((await s.find("peony"))[0].url, undefined, "no address, no shop page");
  assert.equal((await s.card("peony")).items[0].url, null);

  ok(await s.page({ slug: "gulzor-flowers", shop: false }));
  assert.equal((await s.find("peony"))[0].url, undefined, "the shop page is off");
  ok(await s.page({ slug: "gulzor-flowers", shop: true }));
  assert.equal((await s.find("peony"))[0].url, "http://localhost:5192/p/gulzor-flowers/shop");
  assert.equal((await s.card("peony")).items[0].url, "http://localhost:5192/p/gulzor-flowers/shop");

  // The business's own address wins over the shop page.
  ok(await s.ai({ productUrl: "https://shop.example/product/{id}" }));
  assert.equal((await s.find("peony"))[0].url, `https://shop.example/product/${s.peony}`);
});

test("Telegram: the photo gets the same Batafsil button as an integration's card", async () => {
  for (const level of ["act", "answer"]) {
    const s = await shop(level);
    ok(await s.ai({ productUrl: "https://shop.example/product/{id}" }));
    const card = await s.card("peony");
    const rows = photoKeyboard({ id: "11111111-2222-3333-4444-555555555555", card }, 0, "uz");
    assert.deepEqual(rows.at(-1), [{ text: "Batafsil", url: `https://shop.example/product/${s.peony}` }], level);
    assert.equal(rows.length, level === "act" ? 2 : 1, "Add to cart only where the agent takes orders");
    assert.equal(photoKeyboard({ id: "11111111-2222-3333-4444-555555555555", card: { ...card, items: [{ ...card.items[0], url: null }] } }, 0, "ru")?.some((r) => r[0].url) || false, false);
  }
});
