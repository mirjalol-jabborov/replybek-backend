import { z } from "zod";

export const analyticsQuerySchema = z.object({
  days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d), "Use 7, 30 or 90 days.").default(30),
  agent: z.string().uuid().optional().or(z.literal("all").transform(() => undefined)),
});
