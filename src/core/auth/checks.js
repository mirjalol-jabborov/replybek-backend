import { z } from "zod";
import { text } from "../validate.js";
import { PRODUCTS } from "../workspaces/checks.js";

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
  // What the new workspace is for: the AI agent (the dashboard's sign-up) or the CRM (the CRM's).
  product: z.enum(PRODUCTS).default("agent"),
});

export const loginSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
});

// Confirming the email address: the code as typed (spaces allowed), the link's token, a new address.
export const verifyCodeSchema = z.object({ code: z.string().trim().max(20) });
export const verifyLinkSchema = z.object({ token: z.string().min(20).max(100) });
export const changeEmailSchema = z.object({ email: z.string().trim().email().max(200) });
