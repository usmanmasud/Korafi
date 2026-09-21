import { config } from '../config.js';
import { t, categoryLabel, money } from '../i18n.js';
import { getLang, setLang, createReport, recentTickets, ticketStatusText, pendingConfirmation, confirmTicket, rewardText, findTicket } from './reports.js';
import { sendMessages } from './notify.js';

/**
 * Channel-agnostic "was it fixed?" answer used by USSD, SMS and Voice.
 * Returns { kind: 'none' | 'yes' | 'no', lang, reward }.
 */
export async function answerConfirmation(phone, yes) {
  const lang = await getLang(phone);
  const tk = await pendingConfirmation(phone);
  if (!tk) return { kind: 'none', lang };
  const res = await confirmTicket(tk.id, yes);
  if (!res.ok) return { kind: 'none', lang };
  const reward = res.reward || { amount: 0 };
  const body = yes ? t(lang, 'sms.thanks', rewardText(reward)) : t(lang, 'sms.no');
  sendMessages([{ phone, body, ticketId: tk.id }], { kind: yes ? 'reward' : 'confirmation', incidentId: tk.incident_id }).catch((e) =>
    console.error('[korafi] confirmation SMS failed:', e.message),
  );
  return { kind: yes ? 'yes' : 'no', lang, reward, ticket: tk };
}

/** Text lines describing a customer's latest reports (used by USSD "check my report" and voice). */
export async function reportSummary(phone, lang, limit = 3) {
  const rows = await recentTickets(phone, limit);
  return rows.map((r) => ({
    code: r.code,
    line: `#${r.code} ${categoryLabel(r.category, lang)}, ${r.area}: ${ticketStatusText(r, lang)}`,
    ticket: r,
  }));
}

/* ───────────── USSD ───────────── */

const CON = (s) => 'CON ' + s;
const END = (s) => 'END ' + s;

/**
 * Stateless USSD menu: Africa's Talking sends the full path so far in `text`
 * (e.g. "1*3*2"), so we derive the screen from it on every request.
 */
export async function ussdMenu(phone, text) {
  const lang = await getLang(phone);
  const parts = text ? text.split('*') : [];
  const cats = config.categories;
  const areas = config.areas;

  if (parts.length === 0) return CON(t(lang, 'ussd.main', config.businessName));

  switch (parts[0]) {
    case '1': {
      if (parts.length === 1) return CON(t(lang, 'ussd.category', cats, lang));
      const c = Number(parts[1]);
      if (!Number.isInteger(c) || c < 1 || c > cats.length) return END(t(lang, 'ussd.invalid'));
      if (parts.length === 2) return CON(t(lang, 'ussd.area', areas));
      const a = Number(parts[2]);
      if (!Number.isInteger(a) || a < 1 || a > areas.length + 1) return END(t(lang, 'ussd.invalid'));
      const area = a === areas.length + 1 ? 'Other' : areas[a - 1];
      const { ticket, duplicate } = await createReport({ phone, category: cats[c - 1], area, channel: 'ussd' });
      return END(t(lang, duplicate ? 'ussd.dup' : 'ussd.done', ticket.code));
    }
    case '2': {
      const rows = await reportSummary(phone, lang);
      return END(rows.length ? rows.map((r) => r.line).join('\n') : t(lang, 'ussd.none'));
    }
    case '3': {
      const tk = await pendingConfirmation(phone);
      if (!tk) return END(t(lang, 'ussd.noconfirm'));
      if (parts.length === 1) return CON(t(lang, 'ussd.confirmq', tk.code));
      if (parts[1] !== '1' && parts[1] !== '2') return END(t(lang, 'ussd.invalid'));
      const r = await answerConfirmation(phone, parts[1] === '1');
      if (r.kind === 'none') return END(t(lang, 'ussd.noconfirm'));
      return END(r.kind === 'yes' ? t(lang, 'ussd.thanks', rewardText(r.reward)) : t(lang, 'ussd.no'));
    }
    case '4':
      return END(t(lang, 'ussd.help', config.businessName, config.ussdCode));
    case '5': {
      const next = lang === 'ha' ? 'en' : 'ha';
      await setLang(phone, next);
      return END(t(next, 'ussd.lang'));
    }
    default:
      return END(t(lang, 'ussd.invalid'));
  }
}

/* ───────────── SMS keywords ───────────── */

export async function handleIncomingSms(phone, rawText) {
  const lang = await getLang(phone);
  const text = String(rawText || '').replace(/[‘’`]/g, "'").trim().toUpperCase();

  let body;
  if (/^(1|EH|E|YES|Y)$/.test(text)) {
    const r = await answerConfirmation(phone, true);
    return r.kind === 'none' ? sendReply(phone, t(lang, 'sms.nothingToConfirm')) : null; // answerConfirmation already replied
  }
  if (/^(2|A'?A|AA|NO|N)$/.test(text)) {
    const r = await answerConfirmation(phone, false);
    return r.kind === 'none' ? sendReply(phone, t(lang, 'sms.nothingToConfirm')) : null;
  }
  const m = text.match(/^(?:STATUS\s+)?#?(KF\d{3,})$/);
  if (m) {
    const tk = await findTicket(phone, m[1]);
    body = tk
      ? t(lang, 'sms.status', tk.code, ticketStatusText(tk, lang), tk.area, categoryLabel(tk.category, lang))
      : t(lang, 'sms.unknown', config.ussdCode);
  } else {
    body = t(lang, 'sms.help', config.ussdCode);
  }
  return sendReply(phone, body);
}

const sendReply = (phone, body) => sendMessages([{ phone, body }], { kind: 'reply' });

export { money };
