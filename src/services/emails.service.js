// The emails Replybek sends, in English, Uzbek and Russian. Links point at the dashboard (APP_ORIGIN).
import { layout, fill, sendMail } from "../lib/mail.js";

const appUrl = (hash) => `${(process.env.APP_ORIGIN || "http://localhost:5173").replace(/\/$/, "")}/#/${hash}`;
const pick = (lang) => (["en", "uz", "ru"].includes(lang) ? lang : "en");

const ROLE = {
  en: { admin: "an admin", agent: "a teammate" },
  uz: { admin: "administrator", agent: "xodim" },
  ru: { admin: "администратора", agent: "сотрудника" },
};

const TEXT = {
  invite: {
    en: {
      subject: "{inviter} invited you to {workspace} on Replybek",
      heading: "Join {workspace} on Replybek",
      lines: ["{inviter} invited you to join {workspace} as {role}.", "Replybek answers customers with an AI agent and passes conversations to your team when they need a person."],
      button: "Accept invitation",
      footer: "The link works for 7 days. If you weren't expecting this, you can ignore this email.",
    },
    uz: {
      subject: "{inviter} sizni Replybek platformasidagi {workspace} jamoasiga taklif qildi",
      heading: "{workspace} jamoasiga qoʻshiling",
      lines: ["{inviter} sizni {workspace} jamoasiga {role} sifatida taklif qildi.", "Replybek mijozlarga AI agent orqali javob beradi va kerak boʻlsa suhbatni jamoangizga ulaydi."],
      button: "Taklifni qabul qilish",
      footer: "Havola 7 kun amal qiladi. Agar bu xatni kutmagan boʻlsangiz, eʼtibor bermang.",
    },
    ru: {
      subject: "{inviter} приглашает вас в {workspace} в Replybek",
      heading: "Присоединяйтесь к {workspace} в Replybek",
      lines: ["{inviter} приглашает вас в команду {workspace} в роли {role}.", "Replybek отвечает клиентам с помощью ИИ-агента и передаёт разговор вашей команде, когда нужен человек."],
      button: "Принять приглашение",
      footer: "Ссылка действует 7 дней. Если вы не ждали этого письма, просто проигнорируйте его.",
    },
  },
  waiting: {
    en: {
      subject: "A customer is waiting for a person",
      heading: "{visitor} is waiting for a teammate",
      lines: ["They asked for a person in {workspace}.", "Their message: “{message}”"],
      button: "Open the inbox",
      footer: "You get this email when nobody on your team has the inbox open.",
    },
    uz: {
      subject: "Mijoz xodimni kutmoqda",
      heading: "{visitor} xodimni kutmoqda",
      lines: ["U {workspace} chatida xodim bilan gaplashmoqchi.", "Xabari: “{message}”"],
      button: "Kiruvchilarni ochish",
      footer: "Bu xat jamoangizda hech kim kiruvchilarni ochmagan paytda yuboriladi.",
    },
    ru: {
      subject: "Клиент ждёт сотрудника",
      heading: "{visitor} ждёт сотрудника",
      lines: ["Клиент попросил сотрудника в чате {workspace}.", "Сообщение: «{message}»"],
      button: "Открыть входящие",
      footer: "Это письмо приходит, когда никто из команды не открыл входящие.",
    },
  },
  allowance: {
    en: {
      subject: "{workspace} used all its AI messages this month",
      heading: "Your agents have stopped answering",
      lines: ["{workspace} used all {limit} AI messages in its plan this month.", "New chats now go to your team instead. Upgrade the plan to turn answers back on, or they resume on {date}."],
      button: "See plans",
      footer: "You get this email once a month at most, as an owner or admin of {workspace}.",
    },
    uz: {
      subject: "{workspace} bu oy barcha AI xabarlarini ishlatdi",
      heading: "AI agentlaringiz javob berishni toʻxtatdi",
      lines: ["{workspace} bu oy tarifidagi barcha {limit} ta AI xabarni ishlatdi.", "Yangi chatlar endi jamoangizga oʻtadi. Javoblarni qayta yoqish uchun tarifni oshiring, aks holda ular {date} kuni tiklanadi."],
      button: "Tariflarni koʻrish",
      footer: "Bu xat {workspace} egasi yoki administratori sifatida oyiga koʻpi bilan bir marta keladi.",
    },
    ru: {
      subject: "{workspace} израсходовал все ответы ИИ за этот месяц",
      heading: "ИИ-агенты перестали отвечать",
      lines: ["{workspace} израсходовал все {limit} ответов ИИ по тарифу в этом месяце.", "Новые чаты теперь передаются вашей команде. Повысьте тариф, чтобы снова включить ответы, иначе они возобновятся {date}."],
      button: "Посмотреть тарифы",
      footer: "Это письмо приходит не чаще раза в месяц владельцам и администраторам {workspace}.",
    },
  },
  reset: {
    en: {
      subject: "Reset your Replybek password",
      heading: "Choose a new password",
      lines: ["Someone asked to reset the password for {email}. If it was you, choose a new one."],
      button: "Choose a new password",
      footer: "The link works for 1 hour. If you didn't ask, ignore this email: your password stays the same.",
    },
    uz: {
      subject: "Replybek parolini tiklash",
      heading: "Yangi parol tanlang",
      lines: ["{email} uchun parolni tiklash soʻraldi. Agar bu siz boʻlsangiz, yangi parol tanlang."],
      button: "Yangi parol tanlash",
      footer: "Havola 1 soat amal qiladi. Agar siz soʻramagan boʻlsangiz, eʼtibor bermang: parolingiz oʻzgarmaydi.",
    },
    ru: {
      subject: "Сброс пароля Replybek",
      heading: "Задайте новый пароль",
      lines: ["Кто-то запросил сброс пароля для {email}. Если это вы, задайте новый пароль."],
      button: "Задать новый пароль",
      footer: "Ссылка действует 1 час. Если вы не запрашивали сброс, проигнорируйте письмо: пароль останется прежним.",
    },
  },
};

function compose(kind, lang, vars, url) {
  const T = TEXT[kind][pick(lang)];
  const body = layout({ heading: fill(T.heading, vars), lines: T.lines.map((l) => fill(l, vars)), button: T.button, url, footer: fill(T.footer, vars) });
  return { subject: fill(T.subject, vars), ...body };
}

export function sendInvite({ to, lang, inviter, workspace, role, token }) {
  const l = pick(lang);
  return sendMail({ to, ...compose("invite", l, { inviter, workspace, role: ROLE[l][role] || ROLE[l].agent }, appUrl(`invite/${token}`)) });
}

export function sendWaiting({ to, lang, visitor, workspace, message, conversationId }) {
  const short = message.length > 200 ? message.slice(0, 197) + "…" : message;
  return sendMail({ to, ...compose("waiting", lang, { visitor, workspace, message: short }, appUrl(`inbox/${conversationId}`)) });
}

export function sendReset({ to, lang, token }) {
  return sendMail({ to, ...compose("reset", lang, { email: to }, appUrl(`reset/${token}`)) });
}

const MONTHS = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  uz: ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"],
  ru: ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"],
};

export function sendAllowanceUsed({ to, lang, workspace, limit, resetsAt }) {
  const l = pick(lang);
  const d = new Date(resetsAt);
  const day = d.getUTCDate();
  const month = MONTHS[l][d.getUTCMonth()];
  const date = l === "en" ? `${month} ${day}` : l === "uz" ? `${day}-${month}` : `${day} ${month}`;
  const count = l === "en" ? limit.toLocaleString("en-US") : limit.toLocaleString("ru-RU").replace(/[\u00a0\u202f]/g, " ");
  return sendMail({ to, ...compose("allowance", l, { workspace, limit: count, date }, appUrl("settings/billing")) });
}
