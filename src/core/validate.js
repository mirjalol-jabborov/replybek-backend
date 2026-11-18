import { z } from "zod";

export const validate = (schema, source = "body") => (req, res, next) => {
  const parsed = schema.safeParse(req[source]);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request", issues: parsed.error.issues });
  }
  req.valid = parsed.data;
  next();
};

export const text = (max) => z.string().trim().min(1).max(max);
