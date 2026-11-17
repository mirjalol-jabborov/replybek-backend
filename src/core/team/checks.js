import { z } from "zod";
import { text } from "../validate.js";

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
