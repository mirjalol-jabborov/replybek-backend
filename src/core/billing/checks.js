import { z } from "zod";
import { PACKAGE_KEYS, TIERS } from "./packages.js";

export const planSchema = z.object({ plan: z.enum(TIERS) });

// `plan` is the dashboard's older name for the tier; without `package`, the one that gives what the
// workspace has now. `origin`: the app address to come back to (one of APP_ORIGIN), else the dashboard.
export const checkoutSchema = z
  .object({
    package: z.enum(PACKAGE_KEYS).optional(),
    tier: z.enum(TIERS).optional(),
    plan: z.enum(TIERS).optional(),
    return_to: z.enum(["billing", "onboarding"]).default("billing"),
    origin: z.string().trim().max(200).optional(),
  })
  .refine((b) => b.tier || b.plan, { path: ["tier"], params: { code: "tier_required" } });
