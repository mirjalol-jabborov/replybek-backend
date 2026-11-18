import { z } from "zod";
import { text } from "../../core/validate.js";

// ───── Integrations ─────
const template = z.any(); // strings with {{…}}, objects, arrays: checked when the tool runs
const requestBlock = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  path: z.string().trim().min(1).max(500),
  headers: z.record(z.string()).optional(),
  body: template.optional(),
  allow: z.string().max(400).optional(), // a regex the rendered path must match (gates a generic tool to read-only endpoints)
});
export const toolSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/, "Tool names use lowercase letters, digits and underscores."),
  description: text(600),
  when: text(600).optional(),
  // Shown to the customer while it runs ("Checking your orders…"); the widget has a default.
  progress: text(80).optional(),
  kind: z.enum(["read", "write"]).default("read"),
  input: z.object({ type: z.literal("object"), properties: z.record(z.any()).default({}), required: z.array(z.string()).optional() }).passthrough().default({ type: "object", properties: {} }),
  bindings: z.record(z.object({ source: z.enum(["customer", "context", "fixed", "step"]), path: z.string().max(200).optional(), value: z.any().optional() })).default({}),
  request: requestBlock,
  response: z.object({ type: z.enum(["rows", "json"]).default("json"), columns: template.optional(), rows: z.string().optional(), count: z.string().optional(), pick: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), fields: z.record(z.string().max(200)).optional(), filter: z.array(z.object({ field: z.string(), equals: template.optional(), contains: template.optional() })).optional() }).default({ type: "json" }),
  confirm: z.object({ title: template, lines: template.optional(), total: template.optional() }).optional(),
  // Where the AI may use it: the website chat, Telegram, or both (the default).
  channels: z.array(z.enum(["widget", "telegram"])).min(1).optional(),
  // Show the result as cards in the chat (photo, name, price, link): where the list is in the
  // result, and where each field is inside one item. Paths like "products" and "image".
  display: z
    .object({
      type: z.literal("cards").default("cards"),
      items: z.string().max(200).default(""),
      title: z.string().max(200),
      image: z.string().max(200).optional(),
      subtitle: z.string().max(200).optional(),
      price: z.string().max(200).optional(),
      currency: z.string().max(12).optional(),
      url: z.string().max(200).optional(),
      max: z.number().int().min(1).max(10).default(6),
      // carousel: tall cards side by side to swipe; list: wide cards one under another.
      layout: z.enum(["carousel", "list"]).optional(),
      // The item's id, shown to the AI with the cards so "the first one" means the first card.
      id: z.string().max(200).optional(),
      // A button under each card that runs one of this integration's write actions for that item:
      // args map the action's inputs to fields of the item ("id") or to fixed values (1). The
      // customer's tap on a button that names the item is their confirmation.
      action: z
        .object({
          tool: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/),
          label: z.union([z.string().trim().min(1).max(40), z.record(z.string().trim().min(1).max(40)).refine((o) => Object.keys(o).length > 0, "Add the button's text.")]),
          done: z.union([z.string().trim().min(1).max(40), z.record(z.string().trim().min(1).max(40))]).optional(),
          args: z.record(z.union([z.string().max(200), z.number(), z.boolean()])).default({}),
          // The action's input that takes how many: the card shows − 1 + and the tap sends the number.
          quantity: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/i).optional(),
        })
        .optional(),
    })
    .optional(),
});
export const procedureSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/), description: text(600), when: z.string().max(600).optional(),
  input: z.object({ type: z.literal("object"), properties: z.record(z.any()).default({}), required: z.array(z.string()).optional() }).passthrough().default({ type: "object", properties: {} }),
  steps: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), kind: z.enum(["action", "check"]).default("action"),
    tool: z.string().max(48).optional(), args: z.record(z.any()).default({}),
    condition: z.object({ path: text(200), op: z.enum(["equals", "not_equals", "exists", "greater_than", "less_than"]), value: z.any().optional() }).optional(),
    message: z.string().max(400).optional(),
  }).refine(v => v.kind === "action" ? Boolean(v.tool) : Boolean(v.condition), "Choose an action or a condition.")).min(1).max(12),
});
const httpUrl = z.string().trim().url().max(300).refine((u) => /^https?:\/\//i.test(u), "Use an http(s) address.");
export const integrationSchema = z.object({
  agent_id: z.string().uuid(),
  name: text(80),
  mode: z.enum(["server", "in_page"]).default("server"),
  base_url: httpUrl,
  auth: z.object({
    browser_auth: z.enum(["session", "host_token"]).optional(),
    type: z.enum(["oauth", "api_key", "none"]).optional(),
    header: z.string().regex(/^[a-zA-Z0-9-]+$/).max(80).optional(),
    prefix: z.string().max(30).optional(),
    authorize_url: z.string().trim().min(1).max(300),
    token_url: z.string().trim().min(1).max(300),
    client_id: z.string().trim().min(1).max(200),
    scope: z.string().trim().max(200).optional(),
    token_format: z.enum(["form", "json"]).default("form"),
  }).partial().default({}),
  client_secret: z.string().min(1).max(500).optional(),
  headers: z.record(z.string()).default({}),
  context: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), request: requestBlock, pick: z.string().max(200) })).max(10).default([]),
  account: z.object({ request: requestBlock.optional(), pick: z.string().max(200).optional() }).default({}),
  tools: z.array(toolSchema).max(500).default([]),
  procedures: z.array(procedureSchema).max(20).default([]),
  enabled: z.boolean().default(true),
}).refine((v) => v.mode === "in_page" || ["api_key", "none"].includes(v.auth?.type) || (v.auth?.authorize_url && v.auth?.token_url && v.auth?.client_id), {
  message: "Server-mode integrations need authorize_url, token_url and client_id.",
  path: ["auth"],
});
export const integrationUpdateSchema = integrationSchema.innerType().omit({ agent_id: true }).partial();
export const widgetActionSchema = z.object({}).passthrough();
export const widgetToolResultSchema = z.object({ status: z.number().int().min(0).max(599), body: z.any().optional() });
export const toolPreviewSchema = z.object({ args: z.record(z.any()).default({}), context: z.record(z.any()).default({}), base_url: z.string().max(300).optional(), headers: z.record(z.string()).optional(), tool: z.any().optional() });

export const integrationImportSchema = z.object({ format: z.enum(["curl", "openapi", "package"]), source: z.string().min(1).max(800000) });
export const integrationTestSchema = z.object({
  tool: toolSchema, base_url: httpUrl, headers: z.record(z.string()).default({}),
  args: z.record(z.any()).default({}), context: z.record(z.any()).default({}), steps: z.record(z.any()).default({}),
  mode: z.enum(["preview", "mock", "live", "browser"]).default("preview"), mock: z.any().optional(),
  sample_status: z.number().int().min(100).max(599).default(200), access_token: z.string().max(4000).optional(),
});
export const procedureTestSchema = z.object({ procedure: procedureSchema, tools: z.array(toolSchema).max(500), args: z.record(z.any()).default({}), context: z.record(z.any()).default({}), mocks: z.record(z.any()).default({}) });
