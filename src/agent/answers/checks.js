import { z } from "zod";
import { text } from "../../core/validate.js";
import { agentUpdateSchema } from "../agents/checks.js";

// The Playground sends unsaved settings with each test question.
export const testQuestionSchema = z.object({
  question: text(2000),
  history: z.array(z.object({ role: z.enum(["visitor", "ai"]), body: z.string().max(4000) })).max(20).default([]),
  draft: agentUpdateSchema.pick({ instructions: true, tone: true, fallback: true, handoff: true, name: true }).optional(),
});
export const suggestionDraftSchema = z.object({ language: z.enum(["en", "uz", "ru"]).optional(), questions: z.array(text(180)).min(1).max(5).optional() });
