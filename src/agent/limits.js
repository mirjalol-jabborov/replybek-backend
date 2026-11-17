import { rateLimit } from "../core/rate-limit.js";

// Shared by the Playground and the integration tests, and by every AI setup request: one count each.
export const testLimit = rateLimit({ windowMs: 60 * 1000, max: 30, key: (req) => req.user.id, message: "Too many test questions. Wait a minute." });
export const setupAILimit = rateLimit({ windowMs: 60 * 1000, max: 6, key: (req) => req.user.id, message: "Too many AI setup requests. Wait a minute." });
