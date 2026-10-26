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

// Your own name and photo. The dashboard sends the photo cropped to 256 px, so it's tens of KB.
export const profileSchema = z
  .object({
    name: text(80).optional(),
    avatar: z
      .string()
      .max(200000, "The photo is too large.")
      .regex(/^(data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+)?$/, "Use a PNG, JPEG or WebP photo.")
      .optional(),
  })
  .refine((v) => v.name !== undefined || v.avatar !== undefined, "Nothing to change.");

export const registerSchema = z.object({
  name: text(80),
  email: z.string().trim().email().max(200),
  password: z.string().min(10, "Use at least 10 characters.").max(200),
  workspace_name: text(120),
  website: z.string().trim().max(200).optional(),
});

export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  role: z.enum(["admin", "agent"]).default("agent"),
});
export const memberRoleSchema = z.object({ role: z.enum(["admin", "agent"]) });
export const joinSchema = z.object({
  name: text(80),
  password: z.string().min(10, "Use at least 10 characters.").max(200),
});
export const forgotSchema = z.object({ email: z.string().trim().email().max(200) });
export const resetSchema = z.object({
  token: z.string().min(20).max(100),
  password: z.string().min(10, "Use at least 10 characters.").max(200),
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
  suggested_questions: z.array(text(180)).max(5).optional(),
  suggested_questions_i18n: z.object({ en: z.array(text(180)).max(5).optional(), uz: z.array(text(180)).max(5).optional(), ru: z.array(text(180)).max(5).optional() }).strict().optional(),
  suggestion_default_language: z.enum(["en", "uz", "ru"]).optional(),
  allowed_origins: z.array(z.string().trim().url().max(200)).max(20).optional(),
  widget: z
    .object({
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      display_name: z.string().trim().max(80).optional(),
      branding: z.boolean().optional(),
      // The chat avatar: a small image as a data: URL ("" removes it). Shown with <img>, never as markup.
      logo: z
        .string()
        .max(280000, "The logo must be smaller than 200 KB.")
        .regex(/^(data:image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,[A-Za-z0-9+/=]+)?$/, "The logo must be a PNG, JPEG, GIF, WebP, ICO or SVG image.")
        .optional(),
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

// Text may be empty when the message carries a file (checked in the service, which sees the file).
export const replySchema = z.object({ text: z.string().trim().max(4000).default("") });
export const suggestionDraftSchema = z.object({ language: z.enum(["en", "uz", "ru"]).optional(), questions: z.array(text(180)).min(1).max(5).optional() });
export const assignSchema = z.object({ user_id: z.string().uuid().nullable() });

export const widgetStartSchema = z.object({
  name: z.string().trim().max(80).optional(),
  email: z.string().trim().email().max(200).optional(),
  page: z.string().trim().max(500).optional(),
});
export const widgetMessageSchema = z.object({ text: z.string().trim().max(2000).default("") });

export const analyticsQuerySchema = z.object({
  days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d), "Use 7, 30 or 90 days.").default(30),
  agent: z.string().uuid().optional().or(z.literal("all").transform(() => undefined)),
});
export const planSchema = z.object({ plan: z.enum(["starter", "growth", "business"]) });
export const checkoutSchema = planSchema.extend({ return_to: z.enum(["billing", "onboarding"]).default("billing") });
export const onboardingCompleteSchema = z.object({ website: z.string().trim().max(200).optional() });

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
  kind: z.enum(["read", "write"]).default("read"),
  input: z.object({ type: z.literal("object"), properties: z.record(z.any()).default({}), required: z.array(z.string()).optional() }).passthrough().default({ type: "object", properties: {} }),
  bindings: z.record(z.object({ source: z.enum(["customer", "context", "fixed", "step"]), path: z.string().max(200).optional(), value: z.any().optional() })).default({}),
  request: requestBlock,
  response: z.object({ type: z.enum(["rows", "json"]).default("json"), columns: template.optional(), rows: z.string().optional(), count: z.string().optional(), pick: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), fields: z.record(z.string().max(200)).optional(), filter: z.array(z.object({ field: z.string(), equals: template.optional(), contains: template.optional() })).optional() }).default({ type: "json" }),
  confirm: z.object({ title: template, lines: template.optional(), total: template.optional() }).optional(),
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
