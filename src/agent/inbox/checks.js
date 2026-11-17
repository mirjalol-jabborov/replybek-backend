import { z } from "zod";

// Text may be empty when the message carries a file (checked in the service, which sees the file).
export const replySchema = z.object({ text: z.string().trim().max(4000).default("") });
export const assignSchema = z.object({ user_id: z.string().uuid().nullable() });
