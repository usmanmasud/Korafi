import { config } from './config.js';

/** Normalise a phone number to E.164 (+2348012345678). Returns null if it cannot be a phone number. */
export function normalizePhone(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (s.startsWith('+')) {
    return /^\+\d{8,15}$/.test(s) ? s : null;
  }
  if (!/^\d+$/.test(s)) return null;
  const cc = config.countryCode.replace('+', '');
  if (s.startsWith('0')) s = cc + s.slice(1);
  else if (!s.startsWith(cc)) s = cc + s;
  return /^\d{8,15}$/.test(s) ? '+' + s : null;
}

export function maskPhone(p) {
  if (!p || p.length < 8) return p || '';
  return p.slice(0, 6) + '••••' + p.slice(-3);
}
