/**
 * The Telegram Bot API, as much of it as a support agent needs. Transport only: no database and
 * no conversation logic, so the channel adapter stays readable and this file stays testable.
 *
 * Telegram answers HTTP 200 with { ok: false } for its own errors, so every call goes through
 * one place that turns that into a thrown TelegramError.
 */
// Read when a call is made, so a test can point this at its own server.
const api = () => process.env.TELEGRAM_API || "https://api.telegram.org";
const TIMEOUT_MS = 15000;
/** Telegram's own cap on one message. Longer answers are sent as several messages. */
export const MAX_TEXT = 4096;

export class TelegramError extends Error {
  constructor(code, description, parameters = {}) {
    super(description || `Telegram error ${code}`);
    this.code = code;
    this.parameters = parameters;
  }
  /** The token no longer works: the channel can't recover without a new one. */
  get unauthorized() {
    return this.code === 401;
  }
  /** Seconds Telegram asks us to wait before sending to this chat again. */
  get retryAfter() {
    return this.code === 429 ? Number(this.parameters.retry_after) || 1 : 0;
  }
}

async function call(token, method, body, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${api()}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
  } catch (e) {
    throw new TelegramError(0, `Telegram is unreachable: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  const payload = await response.json().catch(() => ({}));
  if (!payload.ok) throw new TelegramError(payload.error_code || response.status, payload.description, payload.parameters || {});
  return payload.result;
}

/**
 * The updates waiting for this bot, used instead of a webhook where Telegram cannot reach us (a
 * laptop). Telegram holds the request open until something arrives or `seconds` pass, and an
 * update is only forgotten once a later `offset` asks for what follows it.
 */
export const getUpdates = (token, { offset = 0, seconds = 25 } = {}) =>
  call(token, "getUpdates", { offset, timeout: seconds, allowed_updates: ["message", "callback_query"] }, (seconds + 10) * 1000);

/** Who the bot is. The first call after a token is pasted: it proves the token works. */
export const getMe = (token) => call(token, "getMe");

export const setWebhook = (token, url, secret) =>
  call(token, "setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });

export const deleteWebhook = (token) => call(token, "deleteWebhook", { drop_pending_updates: true });

export const sendMessage = (token, chatId, text, { keyboard } = {}) =>
  call(token, "sendMessage", { chat_id: chatId, text, reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined });

export const editMessageText = (token, chatId, messageId, text, { keyboard } = {}) =>
  call(token, "editMessageText", { chat_id: chatId, message_id: messageId, text, reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined });

/** The three dots, so a slow answer doesn't look like silence. Lasts five seconds. */
export const sendChatAction = (token, chatId, action = "typing") => call(token, "sendChatAction", { chat_id: chatId, action });

/** Stops the spinner on a tapped button. Telegram spins for 30 s until this is answered. */
export const answerCallbackQuery = (token, id, text) => call(token, "answerCallbackQuery", { callback_query_id: id, text });

/** A file a teammate attached. Photos are shown in the chat, anything else is sent as a file. */
export async function sendFile(token, chatId, { buffer, name, type }, caption) {
  const photo = String(type || "").startsWith("image/");
  const form = new FormData();
  form.set("chat_id", String(chatId));
  if (caption) form.set("caption", caption.slice(0, 1024));
  form.set(photo ? "photo" : "document", new Blob([buffer], { type: type || "application/octet-stream" }), name);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let payload;
  try {
    const response = await fetch(`${api()}/bot${token}/${photo ? "sendPhoto" : "sendDocument"}`, { method: "POST", body: form, signal: controller.signal });
    payload = await response.json().catch(() => ({}));
  } catch (e) {
    throw new TelegramError(0, `Telegram is unreachable: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!payload.ok) throw new TelegramError(payload.error_code || 0, payload.description, payload.parameters || {});
  return payload.result;
}

/** Files arrive as an id; this resolves it to a path, which `download` then fetches. */
export const getFile = (token, fileId) => call(token, "getFile", { file_id: fileId });

export async function download(token, filePath) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${api()}/file/bot${token}/${filePath}`, { signal: controller.signal });
    if (!response.ok) throw new TelegramError(response.status, `Could not download ${filePath}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** Splits a long answer on paragraph, then line, then word boundaries. Never mid-word. */
export function split(text, limit = MAX_TEXT) {
  const parts = [];
  let rest = String(text || "").trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = cut > limit * 0.5 ? cut : limit;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
