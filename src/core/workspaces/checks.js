import { z } from "zod";
import { text } from "../validate.js";

export const PRODUCTS = ["agent", "crm"];

// A workspace can take the other product later.
export const productAddSchema = z.object({ add: z.enum(PRODUCTS) });

export const workspaceUpdateSchema = z.object({
  name: text(120).optional(),
  website: z.string().trim().max(200).optional(),
  timezone: z.string().trim().max(64).optional(),
});
