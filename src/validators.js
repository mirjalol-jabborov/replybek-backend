import { z } from "zod";

export const validate = (schema, source = "body") => (req, res, next) => {
  const parsed = schema.safeParse(req[source]);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request", issues: parsed.error.issues });
  }
  req.valid = parsed.data;
  next();
};

const text = (max) => z.string().trim().min(1).max(max);

export const registerSchema = z.object({
  name: text(80),
  email: z.string().trim().email().max(200),
  password: z.string().min(10, "Use at least 10 characters.").max(200),
  workspace_name: text(120),
  website: z.string().trim().max(200).optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
});

export const workspaceUpdateSchema = z.object({
  name: text(120).optional(),
  website: z.string().trim().max(200).optional(),
  timezone: z.string().trim().max(64).optional(),
});

const tone = z.enum(["professional", "friendly", "concise"]);
export const agentCreateSchema = z.object({
  name: text(80),
  purpose: z.string().trim().max(500).default(""),
  instructions: z.string().trim().max(8000).optional(),
  tone: tone.default("friendly"),
  welcome: z.string().trim().max(500).optional(),
  fallback: z.string().trim().max(500).optional(),
  handoff: z.boolean().default(true),
});
export const agentUpdateSchema = z.object({
  name: text(80).optional(),
  purpose: z.string().trim().max(500).optional(),
  instructions: z.string().trim().max(8000).optional(),
  tone: tone.optional(),
  welcome: text(500).optional(),
  fallback: text(500).optional(),
  handoff: z.boolean().optional(),
  allowed_origins: z.array(z.string().trim().url().max(200)).max(20).optional(),
  widget: z
    .object({
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      display_name: z.string().trim().max(80).optional(),
      branding: z.boolean().optional(),
    })
    .optional(),
});

const pathPrefix = z.string().trim().max(200).regex(/^\//, "Paths start with /");
export const websiteSourceSchema = z.object({
  url: z.string().trim().min(4).max(500),
  include_linked: z.boolean().default(false),
  mode: z.enum(["page", "site"]).optional(),
  include_paths: z.array(pathPrefix).max(50).optional(),
  sync_interval_days: z.union([z.literal(0), z.literal(1), z.literal(7), z.literal(30)]).optional(),
});
export const websitePreviewSchema = z.object({ url: z.string().trim().min(4).max(500) });
export const sourceUpdateSchema = z.object({ sync_interval_days: z.union([z.literal(0), z.literal(1), z.literal(7), z.literal(30)]).optional() });
export const qaSourceSchema = z.object({
  question: text(500),
  answer: text(4000),
  unanswered_id: z.string().uuid().optional(),
});

// The Playground sends unsaved settings with each test question.
export const testQuestionSchema = z.object({
  question: text(2000),
  history: z.array(z.object({ role: z.enum(["visitor", "ai"]), body: z.string().max(4000) })).max(20).default([]),
  draft: agentUpdateSchema.pick({ instructions: true, tone: true, fallback: true, handoff: true, name: true }).optional(),
});

export const replySchema = z.object({ text: text(4000) });
export const assignSchema = z.object({ user_id: z.string().uuid().nullable() });

export const widgetStartSchema = z.object({
  name: z.string().trim().max(80).optional(),
  email: z.string().trim().email().max(200).optional(),
  page: z.string().trim().max(500).optional(),
});
export const widgetMessageSchema = z.object({ text: text(2000) });

export const analyticsQuerySchema = z.object({
  days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d), "Use 7, 30 or 90 days.").default(30),
  agent: z.string().uuid().optional().or(z.literal("all").transform(() => undefined)),
});
export const planSchema = z.object({ plan: z.enum(["starter", "growth", "business"]) });

// ───── Integrations ─────
const template = z.any(); // strings with {{…}}, objects, arrays: checked when the tool runs
const requestBlock = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  path: z.string().trim().min(1).max(500),
  headers: z.record(z.string()).optional(),
  body: template.optional(),
  allow: z.string().max(400).optional(), // a regex the rendered path must match (gates a generic tool to read-only endpoints)
});
const toolSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/, "Tool names use lowercase letters, digits and underscores."),
  description: text(600),
  when: text(600).optional(),
  kind: z.enum(["read", "write"]).default("read"),
  input: z.object({ type: z.literal("object"), properties: z.record(z.any()).default({}), required: z.array(z.string()).optional() }).passthrough().default({ type: "object", properties: {} }),
  request: requestBlock,
  response: z.object({ type: z.enum(["rows", "json"]).default("json"), columns: template.optional(), rows: z.string().optional(), count: z.string().optional(), pick: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), filter: z.array(z.object({ field: z.string(), equals: template.optional(), contains: template.optional() })).optional() }).default({ type: "json" }),
  confirm: z.object({ title: template, lines: template.optional(), total: template.optional() }).optional(),
});
const httpUrl = z.string().trim().url().max(300).refine((u) => /^https?:\/\//i.test(u), "Use an http(s) address.");
export const integrationSchema = z.object({
  agent_id: z.string().uuid(),
  name: text(80),
  mode: z.enum(["server", "in_page"]).default("server"),
  base_url: httpUrl,
  auth: z.object({
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
  tools: z.array(toolSchema).max(30).default([]),
  enabled: z.boolean().default(true),
}).refine((v) => v.mode === "in_page" || (v.auth?.authorize_url && v.auth?.token_url && v.auth?.client_id), {
  message: "Server-mode integrations need authorize_url, token_url and client_id.",
  path: ["auth"],
});
export const integrationUpdateSchema = integrationSchema.innerType().omit({ agent_id: true }).partial();
export const widgetActionSchema = z.object({}).passthrough();
export const widgetToolResultSchema = z.object({ status: z.number().int().min(0).max(599), body: z.any().optional() });
export const toolPreviewSchema = z.object({ args: z.record(z.any()).default({}), context: z.record(z.any()).default({}), base_url: z.string().max(300).optional(), headers: z.record(z.string()).optional(), tool: z.any().optional() });
