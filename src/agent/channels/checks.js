import { z } from "zod";
import { languageOf } from "../../core/languages.js";

// The page's language (<html lang> or data-language), for replies to messages with no clear language of their own.
const pageLanguage = z.string().max(35).optional().transform((v) => (v ? languageOf(v, null) ?? undefined : undefined));

// Who the visitor is, as the page tells the chat (window.Replybek.identify on a signed-in page).
// Shown to the business's team in the Inbox. The photo is an https link or a small image; it's
// only ever shown with <img>.
const PHOTO = /^(https:\/\/[^\s"'<>]{1,2000}|data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+)$/;
const visitorFields = {
  user_id: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  email: z.string().trim().email().max(200).optional(),
  phone: z.string().trim().min(1).max(40).optional(),
  avatar: z.string().max(300000, "The photo is too large.").regex(PHOTO, "Use an https link or a PNG, JPEG, WebP or GIF image.").optional(),
  company: z
    .object({
      id: z.string().trim().max(100).optional(),
      name: z.string().trim().max(120).optional(),
      plan: z.string().trim().max(60).optional(),
      website: z.string().trim().max(200).optional(),
    })
    .strict()
    .optional(),
  // Anything else the business wants its team to see: up to 30 short values.
  attributes: z
    .record(z.string().trim().min(1).max(60), z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
    .refine((o) => Object.keys(o).length <= 30, "Up to 30 attributes.")
    .optional(),
};
export const widgetVisitorSchema = z.object(visitorFields);

// A Telegram bot token, as BotFather prints it: the bot's id, a colon, then its secret.
export const telegramChannelSchema = z.object({
  bot_token: z.string().trim().regex(/^\d{5,}:[A-Za-z0-9_-]{30,}$/, "That doesn't look like a bot token. Copy the whole line BotFather sent."),
});
// The bot's buttons and its Telegram profile; only what is sent changes. Telegram's own limits.
export const telegramBotSchema = z
  .object({
    suggestions: z.boolean().optional(),
    person_button: z.boolean().optional(),
    name: z.string().trim().min(1, "Give the bot a name.").max(64, "Up to 64 characters.").optional(),
    description: z.string().trim().max(512, "Up to 512 characters.").optional(),
    short_description: z.string().trim().max(120, "Up to 120 characters.").optional(),
    // A JPEG made in the browser (Telegram takes only JPEG profile photos).
    photo: z.string().max(700000, "The photo is too large.").regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/, "Use a JPEG photo.").optional(),
    remove_photo: z.boolean().optional(),
  })
  .strict();
export const widgetStartSchema = z.object({
  ...visitorFields,
  page: z.string().trim().max(500).optional(),
  // The browser's time zone ("Asia/Tashkent"), so answers know the customer's "today".
  timezone: z.string().trim().max(64).optional(),
  language: pageLanguage,
  // The chat the visitor left with "Start a new chat", proven by its token.
  previous: z.object({ id: z.string().uuid(), token: z.string().min(10).max(200) }).optional(),
});
export const widgetMessageSchema = z.object({ text: z.string().trim().max(2000).default(""), language: pageLanguage });
