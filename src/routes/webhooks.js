import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { query } from '../db.js';
import { normalizePhone } from '../phone.js';
import { t, categoryLabel, incidentName } from '../i18n.js';
import { getLang, setLang, createReport, attachRecording, pendingConfirmation } from '../services/reports.js';
import { ussdMenu, handleIncomingSms, answerConfirmation, reportSummary } from '../services/conversation.js';
import { logInbound, changed } from '../services/notify.js';

/**
 * Africa's Talking webhooks: USSD, incoming SMS, SMS delivery reports and Voice.
 * Point the callbacks in your AT dashboard at  {PUBLIC_URL}/at/ussd  etc.
 * If WEBHOOK_KEY is set, append ?key=<WEBHOOK_KEY> to each callback URL.
 */
export const webhooks = Router();

const AUDIO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'audio');

function requireKey(req, res, next) {
  if (!config.webhookKey) return next();
  const a = Buffer.from(String(req.query.key || ''));
  const b = Buffer.from(config.webhookKey);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(403).type('text/plain').send('Forbidden');
}
webhooks.use(requireKey);

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(`[korafi] ${req.path} failed:`, err);
    if (req.path.endsWith('/ussd')) return res.type('text/plain').send('END Kuskure ya faru. Sake gwadawa. / An error occurred. Please try again.');
    if (req.path.endsWith('/voice')) return res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>An error occurred. Please try again later.</Say></Response>');
    res.status(500).type('text/plain').send('error');
  });

/* ───────────── USSD ───────────── */

webhooks.post('/ussd', wrap(async (req, res) => {
  const phone = normalizePhone(req.body.phoneNumber);
  if (!phone) return res.type('text/plain').send('END Invalid phone number.');
  const reply = await ussdMenu(phone, String(req.body.text ?? ''));
  res.type('text/plain').send(reply);
}));

/* ───────────── SMS ───────────── */

webhooks.post('/sms', wrap(async (req, res) => {
  const phone = normalizePhone(req.body.from);
  if (phone) {
    await logInbound(phone, 'sms', String(req.body.text || '').slice(0, 500));
    await handleIncomingSms(phone, req.body.text);
  }
  res.type('text/plain').send('OK');
}));

webhooks.post('/sms/delivery', wrap(async (req, res) => {
  const { id, status, failureReason } = req.body;
  if (id) {
    const s = String(status || '').toLowerCase();
    const mapped = s === 'success' ? 'delivered' : s === 'sent' || s === 'submitted' || s === 'buffered' ? 'sent' : s ? 'failed' : 'sent';
    await query('UPDATE messages SET status = $2, detail = COALESCE($3, detail) WHERE provider_id = $1', [id, mapped, failureReason || null]);
    changed('messages');
  }
  res.type('text/plain').send('OK');
}));

/* ───────────── Voice ───────────── */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xml = (inner) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

/** Play a pre-recorded Hausa prompt if one exists in public/audio/<lang>/<key>.mp3, otherwise speak the text. */
function say(lang, key, text) {
  if (fs.existsSync(path.join(AUDIO_DIR, lang, `${key}.mp3`))) {
    return `<Play url="${esc(`${config.publicUrl}/audio/${lang}/${key}.mp3`)}"/>`;
  }
  return `<Say voice="woman" playBeep="false">${esc(text)}</Say>`;
}

const VOICE = {
  ha: {
    welcome: 'Barka da zuwa Korafi.',
    lang: 'Don Hausa, danna 1. For English, press 2.',
    menu: 'Don bayar da rahoton matsala, danna 1. Don duba rahotonka, danna 2. Don tabbatar da gyara, danna 3.',
    category: (cats) => 'Zaɓi matsalar. ' + cats.map((c, i) => `Danna ${i + 1} don ${categoryLabel(c, 'ha')}.`).join(' '),
    area: (areas) => 'Zaɓi unguwarka. ' + areas.map((a, i) => `Danna ${i + 1} don ${a}.`).join(' ') + ` Danna ${areas.length + 1} don sauran.`,
    done: (code) => `An karɓi rahotonka. Lambar ticket ɗinka ita ce ${code.split('').join(' ')}. Za mu aiko maka SMS.`,
    record: 'Don ƙara bayani da muryarka, danna 1. Idan ba haka ba, ka ajiye waya.',
    recordPrompt: 'Ka faɗi matsalarka bayan ƙarar. Idan ka gama, danna alamar tara.',
    thanks: 'Mun gode. Sai an jima.',
    none: 'Babu wani rahoto a yanzu.',
    invalid: 'Zaɓin bai dace ba. Sai an sake kira.',
    confirm: (code) => `An gyara matsalar ticket ${code.split('').join(' ')}? Danna 1 idan eh. Danna 2 idan a'a.`,
    yes: 'Na gode da tabbatar da gyaran.',
    no: 'Mun gode. Za mu ci gaba da aiki a kai.',
    reward: (amt) => `An ƙara ${amt} airtime zuwa layinka.`,
  },
  en: {
    welcome: 'Welcome to Korafi.',
    lang: 'For Hausa, press 1. For English, press 2.',
    menu: 'To report a problem, press 1. To check your report, press 2. To confirm a fix, press 3.',
    category: (cats) => 'Select the problem. ' + cats.map((c, i) => `Press ${i + 1} for ${categoryLabel(c, 'en')}.`).join(' '),
    area: (areas) => 'Select your area. ' + areas.map((a, i) => `Press ${i + 1} for ${a}.`).join(' ') + ` Press ${areas.length + 1} for other.`,
    done: (code) => `Your report is received. Your ticket number is ${code.split('').join(' ')}. We will send you an SMS.`,
    record: 'To add details with your voice, press 1. Otherwise, you may hang up.',
    recordPrompt: 'Describe your problem after the beep. Press hash when you are done.',
    thanks: 'Thank you. Goodbye.',
    none: 'You have no reports at the moment.',
    invalid: 'Invalid choice. Please call again.',
    confirm: (code) => `Has the problem for ticket ${code.split('').join(' ')} been fixed? Press 1 for yes. Press 2 for no.`,
    yes: 'Thank you for confirming the fix.',
    no: 'Thank you. We will keep working on it.',
    reward: (amt) => `${amt} airtime has been added to your line.`,
  },
};

const digits = (n) => String(n).length;
const url = (step, extra = {}) => {
  const q = new URLSearchParams({ step, ...extra });
  if (config.webhookKey) q.set('key', config.webhookKey);
  return `${config.publicUrl}/at/voice?${q.toString()}`;
};
const ask = (lang, key, text, step, extra, n = 1) =>
  `<GetDigits timeout="12" numDigits="${n}" callbackUrl="${esc(url(step, extra))}">${say(lang, key, text)}</GetDigits>`;

webhooks.post('/voice', wrap(async (req, res) => {
  const b = { ...req.query, ...req.body };
  res.type('application/xml');
  const step = b.step || 'start';

  // Recording finished (posted after the call has usually ended).
  if (step === 'recorded') {
    const phone = normalizePhone(b.callerNumber);
    if (phone && b.code && b.recordingUrl) await attachRecording(String(b.code), phone, String(b.recordingUrl));
    return res.send(xml(''));
  }
  if (String(b.isActive) === '0') return res.send(xml(''));

  const phone = normalizePhone(b.callerNumber);
  if (!phone) return res.send(xml('<Reject/>'));
  const dtmf = String(b.dtmfDigits ?? '').trim();
  const cats = config.categories;
  const areas = config.areas;

  if (step === 'start') {
    return res.send(xml(
      say('ha', 'welcome', VOICE.ha.welcome) +
      ask('ha', 'lang', VOICE.ha.lang, 'lang', {}),
    ));
  }

  if (step === 'lang') {
    if (dtmf !== '1' && dtmf !== '2') return res.send(xml(say('ha', 'invalid', VOICE.ha.invalid)));
    await setLang(phone, dtmf === '1' ? 'ha' : 'en');
    const l = dtmf === '1' ? 'ha' : 'en';
    return res.send(xml(ask(l, 'menu', VOICE[l].menu, 'menu', {})));
  }

  const lang = await getLang(phone);
  const V = VOICE[lang];

  if (step === 'menu') {
    if (dtmf === '1') return res.send(xml(ask(lang, 'category', V.category(cats), 'cat', {}, digits(cats.length))));
    if (dtmf === '2') {
      const rows = await reportSummary(phone, lang, 1);
      return res.send(xml(say(lang, 'none', rows.length ? rows[0].line : V.none)));
    }
    if (dtmf === '3') {
      const tk = await pendingConfirmation(phone);
      if (!tk) return res.send(xml(say(lang, 'none', V.none)));
      return res.send(xml(ask(lang, 'confirm', V.confirm(tk.code), 'confirm', {})));
    }
    return res.send(xml(say(lang, 'invalid', V.invalid)));
  }

  if (step === 'confirm') {
    if (dtmf !== '1' && dtmf !== '2') return res.send(xml(say(lang, 'invalid', V.invalid)));
    const r = await answerConfirmation(phone, dtmf === '1');
    if (r.kind === 'none') return res.send(xml(say(lang, 'none', V.none)));
    if (r.kind === 'yes') {
      const amt = r.reward?.amount ? `${r.reward.amount} ${config.currency}` : '';
      return res.send(xml(say(lang, 'yes', V.yes) + (amt ? `<Say>${esc(V.reward(amt))}</Say>` : '')));
    }
    return res.send(xml(say(lang, 'no', V.no)));
  }

  if (step === 'cat') {
    const n = Number(dtmf);
    if (!Number.isInteger(n) || n < 1 || n > cats.length) return res.send(xml(say(lang, 'invalid', V.invalid)));
    return res.send(xml(ask(lang, 'area', V.area(areas), 'area', { cat: cats[n - 1] }, digits(areas.length + 1))));
  }

  if (step === 'area') {
    const n = Number(dtmf);
    const cat = String(b.cat || '');
    if (!cats.includes(cat) || !Number.isInteger(n) || n < 1 || n > areas.length + 1) return res.send(xml(say(lang, 'invalid', V.invalid)));
    const area = n === areas.length + 1 ? 'Other' : areas[n - 1];
    const { ticket } = await createReport({ phone, category: cat, area, channel: 'voice' });
    return res.send(xml(
      say(lang, 'done', V.done(ticket.code)) +
      ask(lang, 'record', V.record, 'rec', { code: ticket.code }),
    ));
  }

  if (step === 'rec') {
    if (dtmf !== '1') return res.send(xml(say(lang, 'thanks', V.thanks)));
    return res.send(xml(
      `<Record finishOnKey="#" maxLength="60" trimSilence="true" playBeep="true" callbackUrl="${esc(url('recorded', { code: String(b.code || '') }))}">${say(lang, 'recordPrompt', V.recordPrompt)}</Record>` +
      say(lang, 'thanks', V.thanks),
    ));
  }

  return res.send(xml(say(lang, 'invalid', V.invalid)));
}));
