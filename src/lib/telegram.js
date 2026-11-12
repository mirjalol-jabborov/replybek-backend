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
 * What the bot is told about: its own chats and button taps, and, once a business account adds it in
 * Telegram Business, that account's connection and the messages in its chats.
 */
export const UPDATES = ["message", "callback_query", "business_connection", "business_message"];

/**
 * The updates waiting for this bot, used instead of a webhook where Telegram cannot reach us (a
 * laptop). Telegram holds the request open until something arrives or `seconds` pass, and an
 * update is only forgotten once a later `offset` asks for what follows it.
 */
export const getUpdates = (token, { offset = 0, seconds = 25 } = {}) =>
  call(token, "getUpdates", { offset, timeout: seconds, allowed_updates: UPDATES }, (seconds + 10) * 1000);

/** A Telegram Business connection by its id: whose account, whether it is on, and what the bot may do. */
export const getBusinessConnection = (token, id) => call(token, "getBusinessConnection", { business_connection_id: id });

/** Who the bot is. The first call after a token is pasted: it proves the token works. */
export const getMe = (token) => call(token, "getMe");

/** `dropPending`: a new connection starts clean; re-registering a working one keeps what is waiting. */
export const setWebhook = (token, url, secret, { dropPending = true } = {}) =>
  call(token, "setWebhook", { url, secret_token: secret, allowed_updates: UPDATES, drop_pending_updates: dropPending });

export const deleteWebhook = (token) => call(token, "deleteWebhook", { drop_pending_updates: true });

/**
 * `keyboard`: buttons under the message (Confirm, Sign in). `replies`: rows of ready answers shown in
 * place of the keyboard (suggested questions); tapping one sends it as the customer's message. An
 * empty `replies` list takes away the ones shown before.
 *
 * `business`: the business connection to send as, in a Telegram Business chat. Telegram allows
 * buttons under a message there, but not the reply keyboard, so `replies` are left out.
 */
export const sendMessage = (token, chatId, text, { keyboard, replies, business } = {}) =>
  call(token, "sendMessage", {
    chat_id: chatId,
    text,
    ...(business ? { business_connection_id: business } : {}),
    reply_markup: keyboard
      ? { inline_keyboard: keyboard }
      : business
        ? undefined
        : replies?.length
          ? { keyboard: replies.map((row) => row.map((label) => ({ text: label }))), resize_keyboard: true, one_time_keyboard: true }
          : Array.isArray(replies)
            ? { remove_keyboard: true }
            : undefined,
  });

/**
 * The bot's own profile: the name in chat headers, the "What can this bot do?" text shown before a
 * customer presses Start (description), and the line on its profile page (short description). Read
 * and written for every language at once (no language_code); the @username stays in BotFather.
 */
export const getMyName = (token) => call(token, "getMyName").then((r) => r.name || "");
export const setMyName = (token, name) => call(token, "setMyName", { name });
export const getMyDescription = (token) => call(token, "getMyDescription").then((r) => r.description || "");
export const setMyDescription = (token, description) => call(token, "setMyDescription", { description });
export const getMyShortDescription = (token) => call(token, "getMyShortDescription").then((r) => r.short_description || "");
export const setMyShortDescription = (token, short_description) => call(token, "setMyShortDescription", { short_description });

/** A new profile photo, as JPEG: Telegram takes it only as an upload, never by URL or file id. */
export async function setMyProfilePhoto(token, jpeg) {
  const form = new FormData();
  // The "photo" parameter describes the photo; the file itself travels in its own part, named in attach://.
  form.set("photo", JSON.stringify({ type: "static", photo: "attach://upload" }));
  form.set("upload", new Blob([jpeg], { type: "image/jpeg" }), "photo.jpg");
  return upload(token, "setMyProfilePhoto", form);
}
export const removeMyProfilePhoto = (token) => call(token, "removeMyProfilePhoto");

/** The bot's current photo, smallest size that still looks sharp in the dashboard; null if none. */
export async function profilePhoto(token, botId) {
  const { photos = [] } = await call(token, "getUserProfilePhotos", { user_id: Number(botId), limit: 1 });
  const sizes = photos[0] || [];
  const size = sizes.find((s) => s.width >= 160) || sizes[sizes.length - 1];
  if (!size) return null;
  const file = await getFile(token, size.file_id);
  return download(token, file.file_path);
}

/** The commands in the bot's menu, in one language (`languageCode`) or by default. */
export const setMyCommands = (token, commands, languageCode) =>
  call(token, "setMyCommands", { commands, ...(languageCode ? { language_code: languageCode } : {}) });

export const editMessageText = (token, chatId, messageId, text, { keyboard, business } = {}) =>
  call(token, "editMessageText", { chat_id: chatId, message_id: messageId, text, ...(business ? { business_connection_id: business } : {}), reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined });

/** The three dots, so a slow answer doesn't look like silence. Lasts five seconds. */
export const sendChatAction = (token, chatId, action = "typing", business = null) =>
  call(token, "sendChatAction", { chat_id: chatId, action, ...(business ? { business_connection_id: business } : {}) });

/** Stops the spinner on a tapped button. Telegram spins for 30 s until this is answered. */
export const answerCallbackQuery = (token, id, text) => call(token, "answerCallbackQuery", { callback_query_id: id, text });

/** A multipart call: anything that carries a file. */
async function upload(token, method, form) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let payload;
  try {
    const response = await fetch(`${api()}/bot${token}/${method}`, { method: "POST", body: form, signal: controller.signal });
    payload = await response.json().catch(() => ({}));
  } catch (e) {
    throw new TelegramError(0, `Telegram is unreachable: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!payload.ok) throw new TelegramError(payload.error_code || 0, payload.description, payload.parameters || {});
  return payload.result;
}

/** A file a teammate attached. Photos are shown in the chat, anything else is sent as a file. */
export async function sendFile(token, chatId, { buffer, name, type }, caption, business = null) {
  const photo = String(type || "").startsWith("image/");
  const form = new FormData();
  form.set("chat_id", String(chatId));
  if (business) form.set("business_connection_id", business);
  if (caption) form.set("caption", caption.slice(0, 1024));
  form.set(photo ? "photo" : "document", new Blob([buffer], { type: type || "application/octet-stream" }), name);
  return upload(token, photo ? "sendPhoto" : "sendDocument", form);
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
