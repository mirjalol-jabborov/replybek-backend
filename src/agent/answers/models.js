export const EMBEDDING_DIM = 1536;
export const models = () => ({
  chat: process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini",
  embedding: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
  moderation: process.env.OPENAI_MODERATION_MODEL || "omni-moderation-latest",
});
