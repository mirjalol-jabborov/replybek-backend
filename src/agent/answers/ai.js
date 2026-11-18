import { real } from "./openai.js";
import { fake } from "./fake-ai.js";

/**
 * Everything Replybek asks of a model goes through `ai`: embeddings for knowledge search,
 * JSON chat for answers and summaries, and moderation. Tests (NODE_ENV=test or AI_FAKE=true)
 * get a deterministic stand-in that needs no key and costs nothing.
 */

export const isFake = () => process.env.AI_FAKE === "true" || process.env.NODE_ENV === "test";
export const ai = new Proxy({}, { get: (_, key) => (isFake() ? fake : real)[key] });
export const fakeAI = fake;
