import { z } from "zod";
import { WIDGET_LANGUAGES } from "../../core/languages.js";
import { text } from "../../core/validate.js";

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
const widgetLanguage = z.enum(WIDGET_LANGUAGES);

export const agentUpdateSchema = z.object({
  name: text(80).optional(),
  purpose: z.string().trim().max(500).optional(),
  instructions: z.string().trim().max(8000).optional(),
  tone: tone.optional(),
  welcome: text(500).optional(),
  fallback: text(500).optional(),
  handoff: z.boolean().optional(),
  suggested_questions: z.array(text(180)).max(5).optional(),
  // Keyed by the widget's languages (WIDGET_LANGUAGES); others are refused.
  suggested_questions_i18n: z.record(widgetLanguage, z.array(text(180)).max(5)).optional(),
  suggestion_default_language: widgetLanguage.optional(),
  // Empty means "show the main welcome message" for that language.
  welcome_i18n: z.record(widgetLanguage, z.string().trim().max(500)).optional(),
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
