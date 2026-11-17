import { z } from "zod";

export const planSchema = z.object({ plan: z.enum(["starter", "growth", "business"]) });
export const checkoutSchema = planSchema.extend({ return_to: z.enum(["billing", "onboarding"]).default("billing") });
