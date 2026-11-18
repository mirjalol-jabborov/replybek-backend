// What a customer reads on a confirm card for a change in the CRM, in the chat's language:
// English, Russian or Uzbek. Everything the AI agent itself is told stays codes; these words are
// the only text the bridge writes for a person, so they are here and nowhere else. Days, sums and
// names read as in the CRM's own messages to customers (shared/notices.js).
import { dayText, moneyText as sumText, nameIn as named } from "../crm/shared/notices.js";

const LANGS = ["en", "ru", "uz"];
/** The first of these that is a language the cards speak, else English. */
export const langOf = (...tries) => tries.find((l) => LANGS.includes(l)) || "en";

const WORDS = {
  en: {
    book: "New booking", cancel: "Cancel the booking", move: "Move the booking", order: "New order",
    service: "Service", when: "When", was: "Was", specialist: "Specialist", anyone: "Any free specialist",
    delivery: "Delivery", address: "Address", payment: "Payment", fee: "Delivery fee", total: "Total", note: "Note",
  },
  ru: {
    book: "Новая запись", cancel: "Отменить запись", move: "Перенести запись", order: "Новый заказ",
    service: "Услуга", when: "Когда", was: "Было", specialist: "Специалист", anyone: "Любой свободный специалист",
    delivery: "Доставка", address: "Адрес", payment: "Оплата", fee: "Стоимость доставки", total: "Итого", note: "Комментарий",
  },
  uz: {
    book: "Yangi bron", cancel: "Bronni bekor qilish", move: "Bronni koʻchirish", order: "Yangi buyurtma",
    service: "Xizmat", when: "Qachon", was: "Avval", specialist: "Mutaxassis", anyone: "Istalgan boʻsh mutaxassis",
    delivery: "Yetkazib berish", address: "Manzil", payment: "Toʻlov", fee: "Yetkazib berish narxi", total: "Jami", note: "Izoh",
  },
};
export const word = (lang, key) => WORDS[langOf(lang)][key];

/** A day "2026-11-18" the way the CRM's messages write one: "Wednesday, 18 November", "18-noyabr, chorshanba". */
export const dayWords = (lang, day) => dayText(day, langOf(lang));
/** A moment "2026-11-18T14:30" as the day and the time. */
export const whenText = (lang, moment) => `${dayWords(lang, moment.slice(0, 10))}, ${moment.slice(11, 16)}`;
/** Whole soʻm, thousands apart: "150 000 soʻm" / "150 000 сум". */
export const moneyText = (lang, n) => sumText(n, langOf(lang));
/** A name the business set: a plain string, or { en, ru, uz } for the starting lists. */
export const nameIn = (lang, name) => named(name ?? "", langOf(lang));
/** The name of an item of one of the business's lists, by id. */
export const listName = (lang, list, id) => nameIn(lang, (list || []).find((x) => x.id === id)?.name ?? "");
