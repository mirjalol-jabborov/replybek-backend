// Email. With SMTP_URL set (e.g. smtps://user:pass@smtp.example.com:465) mail goes out through
// that server, from MAIL_FROM. Without it (development, tests) nothing is sent: each message is
// kept in `outbox` (the last 50) and printed, so links can be followed by hand.
import nodemailer from "nodemailer";

export const outbox = [];
let transport;
const from = () => process.env.MAIL_FROM || "Replybek <no-reply@replybek.uz>";

function getTransport() {
  if (transport !== undefined) return transport;
  transport = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;
  return transport;
}

/** Sends one email. Never throws: a failed email is logged, the request that caused it goes on. */
export async function sendMail({ to, subject, text, html }) {
  const t = getTransport();
  if (!t) {
    outbox.push({ to, subject, text, html, at: new Date() });
    if (outbox.length > 50) outbox.shift();
    if (process.env.NODE_ENV !== "test") console.log(`[mail] to ${to}: ${subject}\n${text}\n`);
    return { sent: false };
  }
  try {
    await t.sendMail({ from: from(), to, subject, text, html });
    return { sent: true };
  } catch (e) {
    console.error(`Email to ${to} failed: ${e.message}`);
    return { sent: false, error: e.message };
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * One email in the brand's look: the wordmark, a heading, a paragraph or two, an ink button and a
 * quiet footer. `lines` are plain text (escaped here). Returns { text, html }.
 */
export function layout({ heading, lines, button, url, footer }) {
  const text = [heading, "", ...lines, "", `${button}: ${url}`, "", footer].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#fcfcfb;font-family:Inter,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#111215">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fcfcfb"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
<tr><td style="font-size:22px;font-weight:700;letter-spacing:-0.04em;padding-bottom:28px">replybek<span style="color:#2d5bd2">.</span></td></tr>
<tr><td style="font-size:22px;font-weight:600;letter-spacing:-0.02em;line-height:1.3;padding-bottom:14px">${esc(heading)}</td></tr>
${lines.map((l) => `<tr><td style="font-size:15px;line-height:1.6;color:#4a4f57;padding-bottom:12px">${esc(l)}</td></tr>`).join("")}
<tr><td style="padding:14px 0 28px"><a href="${esc(url)}" style="display:inline-block;background:#111215;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 20px;border-radius:10px">${esc(button)}</a></td></tr>
<tr><td style="border-top:1px solid #e8e8e6;padding-top:16px;font-size:13px;line-height:1.5;color:#868b93">${esc(footer)}</td></tr>
</table></td></tr></table></body></html>`;
  return { text, html };
}

/** Fills {name} placeholders. */
export const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
