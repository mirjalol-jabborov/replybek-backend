// The words of the spreadsheets, in English, Russian and Uzbek: column headers, sheet names,
// yes and no. An export speaks one language; an import reads a header in any of the three (and a
// few other common ways of writing it), whatever its letter case and however ʻ is written. They are
// part of the file format, not of the app's wording: the server's export and import (src/crm/exchange)
// and the app (to show which headers an import knows) read this one list.

export const LANGUAGES = ["en", "ru", "uz"];

/** A name from the workspace's lists ("VIP" or { en, ru, uz }) in this language, else in any it has. */
export const L = (name, lang) => (name && typeof name === "object" ? name[lang] || name.en || name.ru || name.uz || "" : name || "");

/** Every way a list name may be written: its text, or each of its languages. */
export const spellings = (name) => (name && typeof name === "object" ? Object.values(name) : [name]).filter(Boolean);

/** How a header or a value is compared: letter case, spaces and the ways of writing ʻ don't matter. */
export const plain = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ʻʼ‘’`´']/g, "'")
    .replace(/[*:]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Column headers by key: [en, ru, uz, ...other spellings an import also takes].
 * The first three are what an export writes.
 */
export const HEADERS = {
  id: ["ID", "ID", "ID"],
  name: ["Name", "Имя", "Ism", "Full name", "Customer", "ФИО", "Клиент", "Mijoz", "F.I.Sh."],
  phone: ["Phone", "Телефон", "Telefon", "Phone number", "Mobile", "Номер телефона", "Telefon raqami"],
  telegram: ["Telegram", "Telegram", "Telegram"],
  instagram: ["Instagram", "Instagram", "Instagram"],
  source: ["Source", "Источник", "Manba"],
  tags: ["Tags", "Теги", "Teglar", "Tag", "Тег", "Teg"],
  note: ["Note", "Заметка", "Izoh", "Notes", "Комментарий"],
  added: ["Added", "Добавлен", "Qoʻshilgan"],
  product: ["Product", "Товар", "Mahsulot", "Name", "Название", "Nomi"],
  variant: ["Variant", "Вариант", "Variant"],
  sku: ["SKU", "Артикул", "Artikul"],
  category: ["Category", "Категория", "Kategoriya"],
  unit: ["Unit", "Единица", "Oʻlchov birligi", "Ед. изм."],
  price: ["Price", "Цена", "Narx"],
  cost: ["Cost", "Себестоимость", "Tannarx"],
  lowAt: ["Low stock at", "Мало при остатке", "Kam qoldiq chegarasi"],
  onSale: ["On sale", "В продаже", "Sotuvda"],
  stock: ["Stock", "Остаток", "Qoldiq"],
  reserved: ["Held for orders", "В резерве", "Buyurtmalarga ajratilgan"],
  start: ["Start", "Начало", "Boshlanishi"],
  minutes: ["Minutes", "Минуты", "Daqiqa"],
  customer: ["Customer", "Клиент", "Mijoz"],
  specialist: ["Specialist", "Специалист", "Mutaxassis"],
  services: ["Services", "Услуги", "Xizmatlar"],
  step: ["Step", "Этап", "Bosqich"],
  paid: ["Paid", "Оплачено", "Toʻlangan"],
  created: ["Created", "Создано", "Yaratilgan"],
  number: ["Number", "Номер", "Raqam"],
  items: ["Items", "Товары", "Mahsulotlar"],
  subtotal: ["Goods", "Сумма товаров", "Mahsulotlar summasi"],
  discount: ["Discount", "Скидка", "Chegirma"],
  fee: ["Delivery fee", "Стоимость доставки", "Yetkazish narxi"],
  total: ["Total", "Итого", "Jami"],
  balance: ["Owed", "К оплате", "Toʻlanishi kerak"],
  payment: ["Payment method", "Способ оплаты", "Toʻlov usuli"],
  delivery: ["Delivery", "Способ доставки", "Yetkazish usuli"],
  deliveryDay: ["Delivery day", "День доставки", "Yetkazish kuni"],
  address: ["Address", "Адрес", "Manzil"],
  returned: ["Returned", "Возврат", "Qaytarilgan"],
  qty: ["Qty", "Кол-во", "Soni"],
  order: ["Order", "Заказ", "Buyurtma"],
};

export const SHEETS = {
  customers: ["Customers", "Клиенты", "Mijozlar"],
  products: ["Products", "Товары", "Mahsulotlar"],
  bookings: ["Bookings", "Записи", "Bronlar"],
  orders: ["Orders", "Заказы", "Buyurtmalar"],
  lines: ["Order lines", "Позиции заказов", "Buyurtma qatorlari"],
};

const YES = ["Yes", "Да", "Ha"];
const NO = ["No", "Нет", "Yoʻq"];

const at = (lang) => Math.max(0, LANGUAGES.indexOf(lang));
export const header = (key, lang) => HEADERS[key][at(lang)];
export const sheetName = (key, lang) => SHEETS[key][at(lang)];
export const yesNo = (v, lang) => (v ? YES : NO)[at(lang)];

const YES_WORDS = new Set([...YES, "true", "1", "y", "+", "ha", "xa"].map(plain));
const NO_WORDS = new Set([...NO, "false", "0", "n", "-", "yo'q", "yoq"].map(plain));
/** A yes or no cell as true or false; undefined when it is neither. */
export function readYesNo(text) {
  const t = plain(text);
  if (YES_WORDS.has(t)) return true;
  if (NO_WORDS.has(t)) return false;
  return undefined;
}
