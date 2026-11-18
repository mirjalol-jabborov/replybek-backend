import { z } from "zod";
import { text } from "../validate.js";

export const PRODUCTS = ["agent", "crm"];

// A workspace can take the other product later. `origin`: the app Polar sends the owner back to
// when adding it is a purchase (as for checkout: one of APP_ORIGIN).
export const productAddSchema = z.object({ add: z.enum(PRODUCTS), origin: z.string().trim().max(200).optional() });

export const workspaceUpdateSchema = z.object({
  name: text(120).optional(),
  website: z.string().trim().max(200).optional(),
  timezone: z.string().trim().max(64).optional(),
});
