import { config } from './config.js';

export const CATEGORY_LABELS = {
  power: { ha: 'Babu wuta', en: 'No electricity' },
  water: { ha: 'Babu ruwa', en: 'No water' },
  network: { ha: 'Matsalar network', en: 'Network problem' },
  delivery: { ha: 'Delivery problem', en: 'Delivery problem' },
  other: { ha: 'Sauran matsala', en: 'Other problem' },
};

const INCIDENT_NAMES = {
  power: { ha: 'katsewar wuta', en: 'power outage' },
  water: { ha: 'matsalar ruwa', en: 'water interruption' },
  network: { ha: 'matsalar network', en: 'network outage' },
  delivery: { ha: 'matsalar delivery', en: 'delivery disruption' },
  other: { ha: 'matsala', en: 'service problem' },
};

export const categoryLabel = (c, l) => (CATEGORY_LABELS[c] || CATEGORY_LABELS.other)[l] || c;
export const incidentName = (c, l) => (INCIDENT_NAMES[c] || INCIDENT_NAMES.other)[l];

export const STATUS_LABELS = {
  open: { ha: 'An karɓa', en: 'Received' },
  linked: { ha: 'Ana bincike', en: 'Under investigation' },
  resolved: { ha: 'An gyara - jiran tabbatarwa', en: 'Fixed - awaiting your confirmation' },
  confirmed: { ha: 'An tabbatar an gyara', en: 'Fix confirmed' },
  disputed: { ha: "Ba a gyara ba tukuna", en: 'Not fixed yet' },
};

const T = {
  ha: {
    'ussd.main': (b) => `KORAFI - ${b}\n1. Bayar da rahoton matsala\n2. Duba rahotona\n3. Tabbatar da gyara\n4. Taimako\n5. English`,
    'ussd.category': (cats, l) => 'Zaɓi matsala:\n' + cats.map((c, i) => `${i + 1}. ${categoryLabel(c, l)}`).join('\n'),
    'ussd.area': (areas) => 'Zaɓi unguwa:\n' + areas.map((a, i) => `${i + 1}. ${a}`).join('\n') + `\n${areas.length + 1}. Sauran`,
    'ussd.done': (code) => `An karɓi rahotonka.\nTicket: #${code}\nZa mu aiko maka SMS idan akwai sabon bayani.`,
    'ussd.dup': (code) => `Ka riga ka bayar da wannan rahoto.\nTicket: #${code}\nZa mu sanar da kai.`,
    'ussd.none': () => 'Ba ka da wani rahoto tukuna. Danna 1 don bayar da sabo.',
    'ussd.noconfirm': () => 'Babu wani rahoto da ke jiran tabbatarwa a yanzu.',
    'ussd.confirmq': (code) => `An gyara matsalar?\nTicket #${code}\n1. Eh\n2. A'a`,
    'ussd.thanks': (amt) => `Na gode da tabbatar da gyaran.${amt ? ` An ƙara ${amt} airtime zuwa layinka.` : ''}`,
    'ussd.no': () => 'Mun gode. Za mu ci gaba da aiki a kai kuma mu sanar da kai.',
    'ussd.help': (b, code) => `${b}\nKa buga ${code} don bayar da rahoto.\nAika "STATUS <ticket>" ko "1" (Eh) / "2" (A'a) zuwa lambar SMS namu.`,
    'ussd.lang': () => 'An canza harshe zuwa Hausa.',
    'ussd.invalid': () => 'Zaɓin bai dace ba. Sake gwadawa.',
    'sms.ticket': (code) => `KORAFI: An karɓi rahotonka.\nTicket: #${code}\nZa mu sanar da kai idan akwai sabon bayani.`,
    'sms.ticketIncident': (code, name, area) => `KORAFI: An karɓi rahotonka.\nTicket: #${code}\nAna fama da ${name} a ${area}. Ƙungiyarmu tana bincike.`,
    'sms.incident': (name, area) => `KORAFI: Ana fama da ${name} a ${area}. Ƙungiyar fasaha tana aiki a kai. Za mu sanar da kai idan an gyara.`,
    'sms.resolved': (name, area, code) => `KORAFI: An gyara ${name} a ${area}. An gyara matsalar? Amsa 1 (Eh) ko 2 (A'a), ko ka danna USSD > 3. Ticket #${code}`,
    'sms.thanks': (amt) => `KORAFI: Na gode da tabbatar da gyaran.${amt ? ` An ƙara ${amt} airtime zuwa layinka.` : ''}`,
    'sms.no': () => 'KORAFI: Mun gode. Za mu ci gaba da aiki a kai kuma mu sanar da kai.',
    'sms.status': (code, status, area, cat) => `KORAFI: Ticket #${code} (${cat}, ${area}): ${status}.`,
    'sms.unknown': (code) => `KORAFI: Ba mu sami wannan ticket ba. Ka buga ${code} don bayar da rahoto.`,
    'sms.help': (code) => `KORAFI: Ka buga ${code} don bayar da rahoto. Aika STATUS <ticket> don duba rahoto. Amsa 1 (Eh) ko 2 (A'a) idan an tambaye ka game da gyara.`,
    'sms.nothingToConfirm': () => 'KORAFI: Babu wani rahoto da ke jiran tabbatarwa.',
  },
  en: {
    'ussd.main': (b) => `KORAFI - ${b}\n1. Report a problem\n2. Check my report\n3. Confirm a fix\n4. Help\n5. Hausa`,
    'ussd.category': (cats, l) => 'Select problem:\n' + cats.map((c, i) => `${i + 1}. ${categoryLabel(c, l)}`).join('\n'),
    'ussd.area': (areas) => 'Select area:\n' + areas.map((a, i) => `${i + 1}. ${a}`).join('\n') + `\n${areas.length + 1}. Other`,
    'ussd.done': (code) => `Your report is received.\nTicket: #${code}\nWe will SMS you when there is news.`,
    'ussd.dup': (code) => `You already reported this.\nTicket: #${code}\nWe will keep you posted.`,
    'ussd.none': () => 'You have no reports yet. Press 1 to report a problem.',
    'ussd.noconfirm': () => 'No report is waiting for your confirmation.',
    'ussd.confirmq': (code) => `Has the problem been fixed?\nTicket #${code}\n1. Yes\n2. No`,
    'ussd.thanks': (amt) => `Thank you for confirming.${amt ? ` ${amt} airtime has been added to your line.` : ''}`,
    'ussd.no': () => 'Thank you. We will keep working on it and update you.',
    'ussd.help': (b, code) => `${b}\nDial ${code} to report a problem.\nSMS "STATUS <ticket>" or reply "1" (Yes) / "2" (No) to our SMS number.`,
    'ussd.lang': () => 'Language changed to English.',
    'ussd.invalid': () => 'Invalid choice. Please try again.',
    'sms.ticket': (code) => `KORAFI: Your report is received.\nTicket: #${code}\nWe will notify you of any update.`,
    'sms.ticketIncident': (code, name, area) => `KORAFI: Your report is received.\nTicket: #${code}\nWe are aware of a ${name} in ${area}. Our team is investigating.`,
    'sms.incident': (name, area) => `KORAFI: There is a ${name} in ${area}. Our technical team is working on it. We will tell you when it is fixed.`,
    'sms.resolved': (name, area, code) => `KORAFI: The ${name} in ${area} has been fixed. Is it working for you? Reply 1 (Yes) or 2 (No), or use USSD > 3. Ticket #${code}`,
    'sms.thanks': (amt) => `KORAFI: Thank you for confirming.${amt ? ` ${amt} airtime has been added to your line.` : ''}`,
    'sms.no': () => 'KORAFI: Thank you. We will keep working on it and update you.',
    'sms.status': (code, status, area, cat) => `KORAFI: Ticket #${code} (${cat}, ${area}): ${status}.`,
    'sms.unknown': (code) => `KORAFI: We could not find that ticket. Dial ${code} to report a problem.`,
    'sms.help': (code) => `KORAFI: Dial ${code} to report a problem. SMS STATUS <ticket> to check a report. Reply 1 (Yes) or 2 (No) when asked about a fix.`,
    'sms.nothingToConfirm': () => 'KORAFI: No report is waiting for your confirmation.',
  },
};

export function t(lang, key, ...args) {
  const l = T[lang] ? lang : config.language;
  return T[l][key](...args);
}

export const money = (amount) => `${config.currency === 'NGN' ? '₦' : config.currency + ' '}${amount}`;
