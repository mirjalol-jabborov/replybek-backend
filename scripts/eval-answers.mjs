// Answer quality check against the REAL model (costs a few cents per run).
// It builds a shop agent with knowledge and an integration backed by a local stand-in API, then
// talks to it through the widget like a customer, in Uzbek, Russian and English, and checks that
// it calls a tool when the answer lives in the shop's system, cites knowledge when the answer is
// in the docs, and answers small talk without either.
//
//   node scripts/eval-answers.mjs                 every case once
//   node scripts/eval-answers.mjs --repeat 3      every case three times (catches flaky ones)
//   node scripts/eval-answers.mjs --only order    cases whose name contains "order"
//
// Uses its own database (replybek_eval in the dev container), never replybek or replybek_test.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import pg from "pg";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const REPEAT = Number(arg("--repeat", 1));
const ONLY = arg("--only", "");

process.env.NODE_ENV = "development";
process.env.PGDATABASE = "replybek_eval";
process.env.POLAR_ACCESS_TOKEN = ""; // billing off: the workspace is set to a paid plan below
process.env.ALLOW_PRIVATE_URLS = "true"; // the stand-in API listens on 127.0.0.1
process.env.S3_BUCKET = "";
process.env.UPLOAD_DIR = path.join(os.tmpdir(), "replybek-eval-uploads");
process.env.SMTP_URL = "";

// A fresh database for every run.
{
  const admin = new pg.Client({ host: "127.0.0.1", port: 54329, user: "replybek", password: "replybek", database: "replybek" });
  await admin.connect();
  await admin.query("DROP DATABASE IF EXISTS replybek_eval WITH (FORCE)");
  await admin.query("CREATE DATABASE replybek_eval");
  await admin.end();
}
await import("./migrate.js");
const { default: app } = await import("../src/app.js");
const { query, closeDb } = await import("../src/db.js");
const { drainJobs } = await import("../src/services/jobs.service.js");
const { stopEvents } = await import("../src/services/events.service.js");
const { isFake } = await import("../src/ai.js");
if (isFake()) throw new Error("The eval needs the real model: unset AI_FAKE.");

// ───── The shop's own system ─────
const ORDERS = {
  4127: { order_id: "4127", status: "On the way", items: ["Alpine jacket × 1"], delivery_date: "2026-11-19", total: "890000 UZS", phone: "998901234567" },
  4128: { order_id: "4128", status: "Being packed", items: ["Trail runner shoes × 2"], delivery_date: "2026-11-21", total: "1240000 UZS", phone: "998901234567" },
  5003: { order_id: "5003", status: "Delivered", items: ["Wool hat × 1"], delivery_date: "2026-11-02", total: "150000 UZS", phone: "998935550011" },
};
const PRODUCTS = [
  { sku: "AJ-1", name: "Alpine jacket", color: "black", price: "890000 UZS", in_stock: 7 },
  { sku: "TR-2", name: "Trail runner shoes", color: "red", price: "620000 UZS", in_stock: 0 },
  { sku: "TR-3", name: "Trail runner shoes", color: "blue", price: "620000 UZS", in_stock: 12 },
  { sku: "WH-1", name: "Wool hat", color: "grey", price: "150000 UZS", in_stock: 30 },
];
const BONUS = { 998901234567: 1250, 998935550011: 40 };
const hits = [];
const digits = (s) => String(s || "").replace(/\D/g, "").replace(/^(?!998)(\d{9})$/, "998$1");

const shop = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (status, data) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    hits.push(`${req.method} ${url.pathname}${url.search}`);
    const order = url.pathname.match(/^\/orders\/(\w+)$/);
    if (order && req.method === "GET") return ORDERS[order[1]] ? json(200, ORDERS[order[1]]) : json(404, { message: `Order ${order[1]} not found` });
    if (url.pathname === "/orders" && req.method === "GET") return json(200, Object.values(ORDERS).filter((o) => o.phone === digits(url.searchParams.get("phone"))));
    if (url.pathname === "/products") {
      const q = (url.searchParams.get("q") || "").toLowerCase().split(/\s+/).filter(Boolean);
      return json(200, PRODUCTS.filter((p) => q.some((w) => `${p.name} ${p.color}`.toLowerCase().includes(w))));
    }
    if (url.pathname === "/bonus") return json(200, { phone: digits(url.searchParams.get("phone")), points: BONUS[digits(url.searchParams.get("phone"))] ?? 0 });
    if (/^\/orders\/\w+\/delivery-date$/.test(url.pathname)) return json(200, { ok: true });
    json(404, { message: "no route" });
  });
});
await new Promise((done) => shop.listen(0, "127.0.0.1", done));
const shopUrl = `http://127.0.0.1:${shop.address().port}`;

const server = await new Promise((done) => {
  const s = app.listen(0, "127.0.0.1", () => done(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
process.env.PUBLIC_API_URL = base;

let ipSeq = 1;
function browser() {
  let cookie = "";
  const ip = `198.51.100.${ipSeq++ % 250}`;
  return async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), "CF-Connecting-IP": ip, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch {}
    if (res.status >= 400) throw new Error(`${method} ${p} → ${res.status} ${text.slice(0, 200)}`);
    return parsed;
  };
}

// ───── The business: an owner, an agent, its knowledge and its integration ─────
const owner = browser();
const reg = await owner("POST", "/auth/register", { name: "Eval Owner", email: "eval@replybek.test", password: "correct horse battery", workspace_name: "Northstar Outfitters" });
const wsId = reg.workspaces[0].id;
await query("UPDATE workspaces SET plan = 'business', subscription_status = 'active' WHERE id = $1", [wsId]);
const w = `/w/${wsId}`;
const agent = await owner("POST", `${w}/agents`, { name: "Northstar AI agent", purpose: "Answer customers of an outdoor clothing shop: orders, products, delivery and returns." });
const knowledge = [
  ["How long does delivery take?", "Delivery in Tashkent takes 1–2 days; to other regions of Uzbekistan, 3–5 days. Delivery is free for orders over 500,000 UZS, otherwise it costs 30,000 UZS."],
  ["What is the return policy?", "Unworn items can be returned within 14 days of delivery with the receipt. Refunds go back to the original payment method within 5 working days."],
  ["What payment methods do you accept?", "We accept Click, Payme, Uzcard and Humo cards, and cash on delivery in Tashkent."],
  ["Do you offer gift wrapping?", "Yes, gift wrapping costs 20,000 UZS and can be added at checkout."],
  ["Doʻkon qachon ishlaydi?", "Toshkentdagi doʻkonimiz har kuni soat 10:00 dan 21:00 gacha ishlaydi. Manzil: Amir Temur koʻchasi, 15."],
  ["Как ухаживать за пуховиком?", "Пуховик стирают при 30 °C в деликатном режиме, сушат в барабане с теннисными мячиками. Гладить нельзя."],
];
for (const [question, answer] of knowledge) await owner("POST", `${w}/agents/${agent.id}/sources/qa`, { question, answer });
await drainJobs();
await owner("POST", `${w}/agents/${agent.id}/publish`);
await owner("POST", `${w}/integrations`, {
  agent_id: agent.id,
  name: "Northstar shop",
  mode: "server",
  base_url: shopUrl,
  auth: { type: "none" },
  tools: [
    {
      name: "get_order",
      description: "One order's status, items, delivery date and total, by order number.",
      when: "The customer asks where an order is, when it arrives, or what is in it, and you know the order number.",
      input: { type: "object", properties: { order_id: { type: "string", description: "Order number, digits only", pattern: "^[0-9]{3,10}$" } }, required: ["order_id"] },
      request: { method: "GET", path: "/orders/{{args.order_id}}" },
      response: { type: "json" },
    },
    {
      name: "find_orders",
      description: "All orders placed with a phone number.",
      when: "The customer asks about their orders and gives a phone number instead of an order number.",
      input: { type: "object", properties: { phone: { type: "string", pattern: "^[+0-9 ()-]{7,20}$" } }, required: ["phone"] },
      request: { method: "GET", path: "/orders?phone={{args.phone}}" },
      response: { type: "json" },
    },
    {
      name: "search_products",
      description: "Products with price, color and how many are in stock.",
      when: "The customer asks whether something is available, in stock, or what it costs.",
      input: { type: "object", properties: { query: { type: "string", description: "Product words in English, e.g. 'trail runner red'" } }, required: ["query"] },
      request: { method: "GET", path: "/products?q={{args.query}}" },
      response: { type: "json" },
    },
    {
      name: "bonus_balance",
      description: "Loyalty bonus points for a phone number.",
      input: { type: "object", properties: { phone: { type: "string" } }, required: ["phone"] },
      request: { method: "GET", path: "/bonus?phone={{args.phone}}" },
      response: { type: "json" },
    },
    {
      name: "change_delivery_date",
      kind: "write",
      description: "Moves an order's delivery to another date.",
      input: { type: "object", properties: { order_id: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" } }, required: ["order_id", "date"] },
      request: { method: "POST", path: "/orders/{{args.order_id}}/delivery-date", body: { date: "{{args.date}}" } },
      response: { type: "json" },
      confirm: { title: "Change delivery date", lines: [["Order", "#{{args.order_id}}"], ["New date", "{{args.date}}"]] },
    },
  ],
});

// ───── Cases ─────
// tool: the tool that must be called ("none" = no tool; a list = any of them).
// sources: true = knowledge must be cited, false = must not be, undefined = either.
// card: "confirm" when a change must be proposed. lang: uz | ru | en. turns: earlier messages.
// asks: the reply must ask the customer for something (order number, phone) instead of giving up.
const CASES = [
  // Small talk: no tool, no sources, a real reply.
  { name: "greet uz", say: "salom", tool: "none", sources: false, lang: "uz" },
  { name: "greet uz long", say: "Assalomu alaykum", tool: "none", sources: false, lang: "uz" },
  { name: "thanks uz", say: "rahmat", tool: "none", sources: false, lang: "uz" },
  { name: "greet ru", say: "Здравствуйте!", tool: "none", sources: false, lang: "ru" },
  { name: "thanks ru", say: "спасибо", tool: "none", sources: false, lang: "ru" },
  { name: "greet en", say: "hi there", tool: "none", sources: false, lang: "en" },
  { name: "thanks after answer", turns: ["where is order 4127?"], say: "great, thanks!", tool: "none", sources: false, lang: "en" },

  // Knowledge: cite the docs, no tool.
  { name: "kb delivery uz", say: "Viloyatlarga yetkazib berish necha kun oladi?", tool: "none", sources: true, lang: "uz" },
  { name: "kb returns ru", say: "Как вернуть товар, если не подошёл размер?", tool: "none", sources: true, lang: "ru" },
  { name: "kb payment en", say: "Can I pay with Payme?", tool: "none", sources: true, lang: "en" },
  { name: "kb hours ru (docs in uz)", say: "Во сколько открывается магазин?", tool: "none", sources: true, lang: "ru" },
  { name: "kb care uz (docs in ru)", say: "Puxovikni qanday yuvish kerak?", tool: "none", sources: true, lang: "uz" },
  { name: "kb greeting + question", say: "salom! sovgʻa qadoqlash bormi?", tool: "none", sources: true, lang: "uz" },

  // The answer is in the shop's system: call the tool, never "I don't know".
  { name: "order uz", say: "4127 buyurtmam qayerda?", tool: "get_order", lang: "uz", mentions: /19|yo.?lda|on the way/i },
  { name: "order uz slang", say: "zakazim qachon keladi 4128", tool: "get_order", lang: "uz", mentions: /21/ },
  { name: "order ru", say: "Где мой заказ №4128?", tool: "get_order", lang: "ru", mentions: /21/ },
  { name: "order en", say: "when will order #4127 arrive?", tool: "get_order", lang: "en", mentions: /19/ },
  { name: "order greeting + question", say: "Salom, 4127 raqamli buyurtmani tekshirib bera olasizmi?", tool: "get_order", lang: "uz" },
  { name: "order missing", say: "order 9999 status?", tool: "get_order", lang: "en", mentions: /not found|couldn.?t find|cannot find|can.?t find|no order|check the (order )?number|unable to find|doesn.?t exist/i },
  { name: "order no number uz", say: "buyurtmam qachon keladi?", tool: "none", asks: true, lang: "uz" },
  { name: "order no number en", say: "where is my order?", tool: "none", asks: true, lang: "en" },
  { name: "order follow-up number", turns: ["where is my order?"], say: "4127", tool: "get_order", lang: "en", mentions: /19/ },
  { name: "order follow-up other", turns: ["4127 buyurtma qayerda?"], say: "4128 chi?", tool: "get_order", lang: "uz", mentions: /21/ },
  { name: "orders by phone ru", say: "Мой номер +998 90 123 45 67, какие у меня заказы?", tool: "find_orders", lang: "ru", mentions: /4127|4128/ },
  { name: "stock en", say: "Do you have the Alpine jacket in stock? How much is it?", tool: "search_products", lang: "en", mentions: /890/ },
  { name: "stock uz color", say: "qizil trail runner krossovka bormi?", tool: "search_products", lang: "uz" },
  { name: "price ru", say: "Сколько стоит шерстяная шапка?", tool: "search_products", lang: "ru", mentions: /150/ },
  { name: "bonus uz", say: "bonuslarim qancha? raqamim 90 123 45 67", tool: "bonus_balance", lang: "uz", mentions: /1.?250/ },

  // Harder shapes of the same questions.
  { name: "two questions tool + kb", say: "4127 buyurtmam qayerda? Va qaytarish qoidalari qanday?", tool: "get_order", sources: true, lang: "uz" },
  { name: "uz cyrillic order", say: "Салом, 4127 буюртмам қаерда?", tool: "get_order", lang: "ru", mentions: /19/ },
  { name: "long message", say: "Hello, I ordered a jacket last week for my brother's birthday, the order number was 4127 I think, and I'm worried it won't arrive in time. When is it coming?", tool: "get_order", lang: "en", mentions: /19/ },
  { name: "kb ru slang", say: "скока стоит доставка в самарканд?", tool: "none", sources: true, lang: "ru" },
  { name: "ok after answer", turns: ["when will order #4127 arrive?"], say: "ok", tool: "none", sources: false },

  // A change: propose it with a Confirm card, don't claim it's done.
  { name: "move delivery uz", say: "4127 buyurtmani 2026-11-22 ga koʻchirib bera olasizmi?", tool: "change_delivery_date", card: "confirm", lang: "uz" },
  { name: "move delivery en", say: "Please move delivery of order 4128 to November 25, 2026", tool: "change_delivery_date", card: "confirm", lang: "en" },

  // Neither the docs nor the system know: say so (fallback), don't invent.
  { name: "unknown", say: "Who founded your company?", tool: "none", sources: false, unknown: true, lang: "en" },
];

// Rough language checks: Cyrillic for Russian; for Uzbek vs English, count words only one of them uses.
const CYR = /[Ѐ-ӿ]/;
const UZ_WORDS = /^(siz|sizga|sizning|sizni|qanday|yordam|buyurtma\p{L}*|uchun|kerak|mumkin|bor|yoʻq|yo'q|iltimos|raqam\p{L}*|sana\p{L}*|kun\p{L}*|salom|rahmat|marhamat|arzimaydi|haqida|mamnun\p{L}*|mavjud|emas|hozirda|va|bilan|bu|shu|ham|edi|qiladi|boʻladi|bo'ladi|beraman|bera|olaman|olasiz|kutilmoqda|yetkaz\p{L}*|tasdiq\p{L}*|tugma\p{L}*|bosing|tekshir\p{L}*|topilmadi|ballaringiz|narxi|turadi|omborda|rangda)$/iu;
const EN_WORDS = /^(the|is|are|your|you|you're|you’re|welcome|hello|hi|thanks|order|please|have|has|will|be|it|and|with|can|for|to|of|in|on|we|our|this|that|confirm|details|delivery|not|found|help)$/i;
function langOk(lang, text) {
  if (lang === "ru") return CYR.test(text);
  if (CYR.test(text)) return false;
  const words = text.toLowerCase().match(/[\p{L}ʻ'’]+/gu) || [];
  const uz = words.filter((x) => UZ_WORDS.test(x)).length;
  const en = words.filter((x) => EN_WORDS.test(x)).length;
  return lang === "uz" ? uz > en : en > uz;
}
const ASKS = /\?|raqam|номер|number|phone|telefon|order id/i;

const fallbackText = (await owner("GET", `${w}/agents/${agent.id}`)).fallback;

async function runCase(c) {
  const v = browser();
  const key = agent.public_key;
  const start = await v("POST", `/widget/${key}/conversations`, { timezone: "Asia/Tashkent" });
  const vt = { "X-Visitor-Token": start.visitor_token };
  const say = (text) => v("POST", `/widget/${key}/conversations/${start.conversation_id}/messages`, { text }, vt);
  for (const t of c.turns || []) await say(t);
  const mark = hits.length;
  const out = await say(c.say);
  const reply = out.messages.filter((m) => m.role === "ai").at(-1) || {};
  const called = hits.slice(mark).map((h) => h.split(" ")[1]);
  const usedTool = (name) => ({ get_order: /^\/orders\/\w+$/, find_orders: /^\/orders$/, search_products: /^\/products$/, bonus_balance: /^\/bonus$/ })[name];
  const text = reply.body || "";
  const problems = [];
  const expectTools = c.tool === "none" ? [] : [c.tool].flat();
  const wrote = reply.card?.type === "confirm";
  if (c.tool === "none" && (called.length || wrote)) problems.push(`called a tool (${called.join(", ") || "write"}) when none was needed`);
  for (const t of expectTools) {
    if (t === "change_delivery_date" ? !wrote : !called.some((p) => usedTool(t)?.test(p.split("?")[0]))) problems.push(`didn't call ${t}`);
  }
  if (c.card === "confirm" && !wrote) problems.push("no confirm card");
  if (c.card === "confirm" && /\b(done|changed|moved|oʻzgartirildi|ko.?chirildi|изменен|перенес)\b/i.test(text) && !/confirm|tasdiq|подтверд/i.test(text)) problems.push("claims the change is done");
  const nSources = (reply.sources || []).length;
  if (c.sources === true && !nSources) problems.push("no sources shown");
  if (c.sources === false && nSources) problems.push(`showed ${nSources} source(s)`);
  const isFallback = text.trim() === fallbackText.trim() || reply.kind === "fallback";
  if (/can.?t answer right now/i.test(text)) problems.push("the answer failed (error reply, handed off)");
  if (!text.trim()) problems.push("empty reply");
  if (!c.unknown && isFallback) problems.push("said I don't know (fallback)");
  if (c.unknown && nSources) problems.push("cited sources for an unknown question");
  if (c.asks && !ASKS.test(text)) problems.push("didn't ask for the order number or phone");
  if (c.mentions && !c.mentions.test(text)) problems.push(`answer is missing ${c.mentions}`);
  if (c.lang && !langOk(c.lang, text)) problems.push(`not in ${c.lang}`);
  return { ok: !problems.length, problems, text, called, nSources, card: reply.card?.type };
}

const selected = CASES.filter((c) => !ONLY || c.name.includes(ONLY));
const failures = [];
let passed = 0;
for (const c of selected) {
  for (let i = 0; i < REPEAT; i++) {
    let r;
    try {
      r = await runCase(c);
    } catch (e) {
      r = { ok: false, problems: [e.message], text: "", called: [], nSources: 0 };
    }
    const tag = REPEAT > 1 ? ` #${i + 1}` : "";
    console.log(`${r.ok ? "PASS" : "FAIL"} ${c.name}${tag}  [tools: ${r.called.join(", ") || "-"}${r.card ? `, card: ${r.card}` : ""}, sources: ${r.nSources}]`);
    console.log(`     > ${c.say}`);
    console.log(`     < ${r.text.replace(/\s+/g, " ").slice(0, 220)}`);
    if (!r.ok) {
      console.log(`     ! ${r.problems.join("; ")}`);
      failures.push(`${c.name}${tag}: ${r.problems.join("; ")}`);
    } else passed++;
  }
}
console.log(`\n${passed}/${selected.length * REPEAT} passed`);
if (failures.length) console.log(`Failures:\n  ${failures.join("\n  ")}`);

await stopEvents();
server.close();
shop.close();
await closeDb();
process.exit(failures.length ? 1 : 0);
