// What a new CRM workspace starts with. These are only starting values: every list is edited in
// CRM settings, and nothing in the code depends on a particular entry. Names are {en, ru, uz}
// until someone renames them (then they are plain strings); names that read the same in every
// language are plain strings from the start.

/** Booking rules. Minutes, unless said otherwise. */
const RULES = () => ({
  minNotice: 60, // a customer can book no later than this long before the start
  maxDays: 30, // …and no further ahead than this many days
  cancelUntil: 120, // a customer can cancel or move a booking until this long before it
  buffer: 0, // kept free after every visit (a service can set its own)
  step: 15, // start times are offered every this many minutes
  override: true, // the team may book outside these rules after a warning
});
/** Delivery rules of the Store module. */
const DELIVERY = () => ({
  time: "both", // "windows" | "exact" | "both": how the delivery time is chosen
  windows: [
    { from: "09:00", to: "12:00" },
    { from: "12:00", to: "15:00" },
    { from: "15:00", to: "18:00" },
    { from: "18:00", to: "21:00" },
  ],
  daysOff: [], // weekdays without delivery (0 = Sunday)
  closed: [], // [{ date, note }] dates without delivery
  sameDayUntil: "18:00", // an order made after this can't be delivered the same day ("" = no limit)
  prepMinutes: 90, // the earliest delivery is this long after the order
  maxDays: 30, // the furthest day a delivery can be planned
  override: true, // the team may plan a delivery outside these rules after a warning
});
const SETTINGS = () => ({
  dayStart: "09:00",
  dayEnd: "21:00",
  slot: 30, // the calendar's grid, minutes
  remindBefore: 120,
  remindOn: true,
  confirmByAi: true,
  lowStockAlerts: true,
  rules: RULES(),
  delivery: DELIVERY(),
  // The CRM works without the Replybek AI agent. The snapshot shows aiConnected only when the
  // workspace also has the agent product.
  aiConnected: false,
  aiAct: true,
  // The guided setup's own record; what is set up is read from the data itself.
  onboarding: { finishedAt: null, dismissedAt: null, skipped: [] },
});
const SOURCES = () => [
  { id: "telegram", name: "Telegram", icon: "send" },
  { id: "instagram", name: "Instagram", icon: "globe" },
  { id: "phone", name: { en: "Phone call", ru: "Звонок", uz: "Qoʻngʻiroq" }, icon: "phone" },
  { id: "website", name: { en: "Website", ru: "Сайт", uz: "Veb-sayt" }, icon: "monitor" },
  { id: "walkin", name: { en: "Walk-in", ru: "Пришёл сам", uz: "Oʻzi kelgan" }, icon: "user" },
];
const TAGS = () => [{ id: "vip", name: "VIP", tone: "amber" }];
/** The steps of the bookings board. `kind` is what a step means to the system (shared/lists.js). */
const APPT_STAGES = () => [
  { id: "new", name: { en: "New", ru: "Новая", uz: "Yangi" }, tone: "amber", kind: "pending" },
  { id: "confirmed", name: { en: "Confirmed", ru: "Подтверждена", uz: "Tasdiqlangan" }, tone: "blue", kind: "booked" },
  { id: "arrived", name: { en: "Arrived", ru: "Пришёл", uz: "Keldi" }, tone: "blue", kind: "here" },
  { id: "in_service", name: { en: "In service", ru: "На приёме", uz: "Xizmatda" }, tone: "green", kind: "here" },
  { id: "done", name: { en: "Done", ru: "Завершена", uz: "Yakunlandi" }, tone: "green", kind: "done" },
  { id: "no_show", name: { en: "No-show", ru: "Не пришёл", uz: "Kelmadi" }, tone: "red", kind: "noshow" },
  { id: "cancelled", name: { en: "Cancelled", ru: "Отменена", uz: "Bekor qilingan" }, tone: "", kind: "cancelled" },
];
/** The steps of the orders board. */
const ORDER_STAGES = () => [
  { id: "new", name: { en: "New", ru: "Новый", uz: "Yangi" }, tone: "amber", kind: "open" },
  { id: "confirmed", name: { en: "Confirmed", ru: "Подтверждён", uz: "Tasdiqlangan" }, tone: "blue", kind: "reserved" },
  { id: "packing", name: { en: "Packing", ru: "Сборка", uz: "Yigʻilmoqda" }, tone: "blue", kind: "reserved" },
  { id: "delivering", name: { en: "Out for delivery", ru: "В доставке", uz: "Yetkazilmoqda" }, tone: "blue", kind: "reserved" },
  { id: "delivered", name: { en: "Delivered", ru: "Доставлен", uz: "Yetkazildi" }, tone: "green", kind: "done" },
  { id: "cancelled", name: { en: "Cancelled", ru: "Отменён", uz: "Bekor qilingan" }, tone: "", kind: "cancelled" },
];
const DELIVERY_METHODS = () => [
  { id: "courier", name: { en: "Courier", ru: "Курьер", uz: "Kuryer" }, icon: "truck", address: true, fee: 30000 },
  { id: "pickup", name: { en: "Pickup", ru: "Самовывоз", uz: "Olib ketish" }, icon: "bag", address: false, fee: 0 },
];
const PAYMENT_METHODS = () => [
  { id: "cash", name: { en: "Cash", ru: "Наличные", uz: "Naqd" } },
  { id: "click", name: "Click" },
  { id: "payme", name: "Payme" },
  { id: "card", name: { en: "Card", ru: "Карта", uz: "Karta" } },
];
const UNITS = () => [
  { id: "pcs", name: { en: "pcs", ru: "шт", uz: "dona" } },
  { id: "box", name: { en: "box", ru: "кор.", uz: "quti" } },
  { id: "kg", name: { en: "kg", ru: "кг", uz: "kg" } },
  { id: "l", name: { en: "l", ru: "л", uz: "l" } },
];

/** The keys of crm_settings.data, which are also the top-level keys PUT /settings takes. */
export const TOP_KEYS = ["modules", "settings", "sources", "tags", "fields", "apptStages", "orderStages", "deliveryMethods", "paymentMethods", "units", "serviceCategories", "productCategories"];

/**
 * crm_settings.data for a new workspace. Every workspace has every list, whichever modules are
 * on: a module can be switched on at any time. Both modules start off; the business picks what
 * it needs in CRM settings.
 */
export const defaults = () => ({
  modules: { booking: false, store: false },
  settings: SETTINGS(),
  sources: SOURCES(),
  tags: TAGS(),
  fields: { customer: [], appointment: [], order: [] },
  apptStages: APPT_STAGES(),
  orderStages: ORDER_STAGES(),
  deliveryMethods: DELIVERY_METHODS(),
  paymentMethods: PAYMENT_METHODS(),
  units: UNITS(),
  serviceCategories: [],
  productCategories: [],
});

/**
 * Stored data with whatever it lacks filled from the defaults. A key added to the defaults
 * later (a new setting, a new list) reads right for workspaces made before it, with no migration.
 */
export function withDefaults(data = {}) {
  const d = defaults();
  return {
    ...d,
    ...data,
    modules: { ...d.modules, ...data.modules },
    settings: { ...d.settings, ...data.settings },
    fields: { ...d.fields, ...data.fields },
  };
}
