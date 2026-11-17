import { z } from "zod";

export const onboardingCompleteSchema = z.object({ website: z.string().trim().max(200).optional() });
