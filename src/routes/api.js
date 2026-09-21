import { Router } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { query, dbKind } from '../db.js';
import { atMode } from '../at.js';
import { CATEGORY_LABELS } from '../i18n.js';
import { normalizePhone } from '../phone.js';
import { overview } from '../services/stats.js';
import { bus } from '../services/notify.js';
import {
  UserError, createReport, createManualIncident, setIncidentStatus, broadcastIncident,
  resolveIncident, resolveTicket, incidentDetail,
} from '../services/reports.js';

export const api = Router();

/* ───────────── session auth (single dashboard password) ───────────── */

const COOKIE = 'korafi_session';
const sign = (payload) => crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

function makeToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 12 * 3600 * 1000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function validToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return false;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now();
  } catch {
    return false;
  }
}

const readCookie = (req, name) => {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
};

const attempts = new Map();
function limited(ip) {
  const now = Date.now();
  const rec = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60000);
  attempts.set(ip, rec);
  return rec.length >= 10;
}

export function requireAuth(req, res, next) {
  if (validToken(readCookie(req, COOKIE))) return next();
  res.status(401).json({ error: 'Not signed in' });
}

// State-changing calls must be JSON: blocks cross-site form posts (CSRF) on top of SameSite cookies.
api.use((req, res, next) => {
  if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ error: 'Content-Type must be application/json' });
  next();
});

api.post('/auth/login', (req, res) => {
  const ip = req.ip;
  if (limited(ip)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const ok = crypto.timingSafeEqual(digest(req.body?.password), digest(config.dashboardPassword));
  if (!ok) {
    attempts.get(ip).push(Date.now());
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(makeToken())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${12 * 3600}${config.isProd ? '; Secure' : ''}`);
  res.json({ ok: true });
});

api.post('/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

api.get('/auth/me', (req, res) => res.json({ signedIn: validToken(readCookie(req, COOKIE)) }));

/* ───────────── dashboard data ───────────── */

api.use(requireAuth);

api.get('/config', (req, res) => {
  res.json({
    business: config.businessName,
    ussdCode: config.ussdCode,
    language: config.language,
    reward: config.reward,
    currency: config.currency,
    categories: config.categories.map((key) => ({ key, label: CATEGORY_LABELS[key].en, labelHa: CATEGORY_LABELS[key].ha })),
    areas: config.areas,
    mapCenter: config.mapCenter,
    threshold: config.incident.threshold,
    windowMinutes: config.incident.windowMinutes,
    africasTalking: atMode(),
    database: dbKind(),
  });
});

api.get('/overview', async (req, res) => res.json(await overview()));

api.get('/incidents/:id', async (req, res) => res.json(await incidentDetail(Number(req.params.id))));

api.post('/incidents', async (req, res) => {
  const inc = await createManualIncident(String(req.body?.category), String(req.body?.area));
  res.status(201).json(inc);
});
api.post('/incidents/:id/status', async (req, res) => res.json(await setIncidentStatus(Number(req.params.id), String(req.body?.status))));
api.post('/incidents/:id/broadcast', async (req, res) => res.json(await broadcastIncident(Number(req.params.id), req.body?.message)));
api.post('/incidents/:id/resolve', async (req, res) => res.json(await resolveIncident(Number(req.params.id))));
api.post('/tickets/:id/resolve', async (req, res) => res.json(await resolveTicket(Number(req.params.id))));

/**
 * Demo tool: file reports without a phone. With no `phone`, synthetic +23400… numbers are used and
 * nothing is ever sent to the network. With a real `phone`, the normal SMS confirmation goes out.
 */
api.post('/simulate', async (req, res) => {
  const { category, area } = req.body || {};
  const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 1, 1), 50);
  let phones;
  if (req.body?.phone) {
    const p = normalizePhone(req.body.phone);
    if (!p) throw new UserError('Invalid phone number');
    phones = [p];
  } else {
    phones = Array.from({ length: count }, () => '+23400' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'));
  }
  const made = [];
  for (const phone of phones) {
    const r = await createReport({ phone, category, area, channel: 'sim' });
    await r.sms;
    made.push(r.ticket.code);
  }
  res.json({ created: made.length, tickets: made });
});

api.get('/export/reports.csv', async (req, res) => {
  const rows = await query('SELECT code, phone, category, area, channel, status, created_at, resolved_at, confirmed_at FROM tickets ORDER BY id');
  const cell = (v) => {
    const s = v instanceof Date ? v.toISOString() : String(v ?? '');
    return /^[=+\-@]/.test(s) || /[",\n]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s;
  };
  const head = ['code', 'phone', 'category', 'area', 'channel', 'status', 'created_at', 'resolved_at', 'confirmed_at'];
  res.type('text/csv').attachment('korafi-reports.csv').send([head.join(','), ...rows.map((r) => head.map((h) => cell(r[h])).join(','))].join('\n'));
});

/** Server-sent events: the dashboard refetches /overview whenever something changes. */
api.get('/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const onChange = (e) => res.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  bus.on('change', onChange);
  req.on('close', () => {
    clearInterval(ping);
    bus.off('change', onChange);
  });
});

api.use((err, req, res, next) => {
  if (err instanceof UserError) return res.status(err.status).json({ error: err.message });
  console.error('[korafi] api error:', err);
  res.status(500).json({ error: 'Something went wrong' });
});
