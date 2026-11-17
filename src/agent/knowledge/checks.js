import { z } from "zod";
import { text } from "../../core/validate.js";

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
