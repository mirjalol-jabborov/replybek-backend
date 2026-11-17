/** "90 123 45 67", "+998 (90) 123-45-67" → "+998901234567"; null when it isn't an Uzbek mobile number. */
export function normalPhone(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  const local = d.length === 12 && d.startsWith("998") ? d.slice(3) : d.length === 9 ? d : null;
  return local ? `+998${local}` : null;
}
