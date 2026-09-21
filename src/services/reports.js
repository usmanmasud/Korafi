import { config } from '../config.js';
import { query, exclusive } from '../db.js';
import { t, incidentName, categoryLabel, STATUS_LABELS, money } from '../i18n.js';
import { sendAirtime } from '../at.js';
import { sendMessages, changed } from './notify.js';

const DUPLICATE_WINDOW_MIN = 60;
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/* ───────────── customers ───────────── */

export async function getLang(phone) {
  const [c] = await query('SELECT language FROM customers WHERE phone = $1', [phone]);
  return c?.language || config.language;
}

export async function ensureCustomer(phone) {
  await query('INSERT INTO customers (phone, language) VALUES ($1, $2) ON CONFLICT (phone) DO NOTHING', [phone, config.language]);
}

export async function setLang(phone, language) {
  await query(
    'INSERT INTO customers (phone, language) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET language = EXCLUDED.language',
    [phone, language],
  );
}

/* ───────────── incidents ───────────── */

function confidence(customers) {
  const th = config.incident.threshold;
  if (customers >= th * 2) return 'HIGH';
  if (customers >= th * 1.5) return 'MEDIUM';
  return 'LOW';
}

async function refreshIncident(id) {
  const [s] = await query(
    `SELECT COUNT(*)::int AS reports, COUNT(DISTINCT phone)::int AS customers,
            MIN(created_at) AS first_at, MAX(created_at) AS last_at
     FROM tickets WHERE incident_id = $1`,
    [id],
  );
  await query(
    `UPDATE incidents SET report_count = $2, customer_count = $3, first_report_at = $4, last_report_at = $5, confidence = $6 WHERE id = $1`,
    [id, s.reports, s.customers, s.first_at, s.last_at, confidence(s.customers)],
  );
  const [inc] = await query('SELECT * FROM incidents WHERE id = $1', [id]);
  return inc;
}

async function newIncident(category, area, source, status) {
  const [row] = await query(
    `INSERT INTO incidents (code, category, area, source, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    ['TMP-' + Math.random().toString(36).slice(2), category, area, source, status],
  );
  await query('UPDATE incidents SET code = $2 WHERE id = $1', [row.id, 'INC' + (100 + row.id)]);
  return row.id;
}

/** Called inside the exclusive lock for every new ticket. */
async function detectIncident(ticket) {
  if (ticket.area === 'Other') return { incident: null, created: false };

  const [open] = await query(
    `SELECT * FROM incidents WHERE category = $1 AND area = $2 AND status IN ('possible','investigating') LIMIT 1`,
    [ticket.category, ticket.area],
  );
  if (open) {
    await query(`UPDATE tickets SET incident_id = $2, status = 'linked' WHERE id = $1`, [ticket.id, open.id]);
    return { incident: await refreshIncident(open.id), created: false };
  }

  const candidates = await query(
    `SELECT id, phone FROM tickets
     WHERE category = $1 AND area = $2 AND incident_id IS NULL AND status = 'open' AND created_at >= $3::timestamptz`,
    [ticket.category, ticket.area, ago(config.incident.windowMinutes)],
  );
  const distinct = new Set(candidates.map((c) => c.phone));
  if (distinct.size < config.incident.threshold) return { incident: null, created: false };

  const id = await newIncident(ticket.category, ticket.area, 'auto', 'possible');
  for (const c of candidates) await query(`UPDATE tickets SET incident_id = $2, status = 'linked' WHERE id = $1`, [c.id, id]);
  return { incident: await refreshIncident(id), created: true };
}

export async function createManualIncident(category, area) {
  if (!config.categories.includes(category)) throw new UserError('Unknown category');
  if (!config.areas.includes(area)) throw new UserError('Unknown area');
  return exclusive(async () => {
    const [existing] = await query(
      `SELECT id FROM incidents WHERE category = $1 AND area = $2 AND status IN ('possible','investigating')`,
      [category, area],
    );
    if (existing) throw new UserError('An active incident already exists for this category and area', 409);
    const id = await newIncident(category, area, 'manual', 'investigating');
    await query(
      `UPDATE tickets SET incident_id = $3, status = 'linked'
       WHERE category = $1 AND area = $2 AND incident_id IS NULL AND status = 'open' AND created_at >= $4::timestamptz`,
      [category, area, id, ago(24 * 60)],
    );
    const inc = await refreshIncident(id);
    changed('incident');
    return inc;
  });
}

export async function setIncidentStatus(id, status) {
  if (!['investigating'].includes(status)) throw new UserError('Unsupported status');
  const [inc] = await query('SELECT * FROM incidents WHERE id = $1', [id]);
  if (!inc) throw new UserError('Incident not found', 404);
  if (inc.status === 'resolved') throw new UserError('Incident is already resolved', 409);
  await query('UPDATE incidents SET status = $2 WHERE id = $1', [id, status]);
  changed('incident');
  return { ...inc, status };
}

async function incidentRecipients(incidentId, statuses) {
  return query(
    `SELECT t.id, t.phone, t.code, t.status, COALESCE(c.language, $2) AS language
     FROM tickets t LEFT JOIN customers c ON c.phone = t.phone
     WHERE t.incident_id = $1 AND t.status = ANY($3::text[]) ORDER BY t.id`,
    [incidentId, config.language, statuses],
  );
}

function firstPerPhone(rows) {
  const seen = new Map();
  for (const r of rows) if (!seen.has(r.phone)) seen.set(r.phone, r);
  return [...seen.values()];
}

export async function broadcastIncident(id, customMessage) {
  const [inc] = await query('SELECT * FROM incidents WHERE id = $1', [id]);
  if (!inc) throw new UserError('Incident not found', 404);
  if (inc.status === 'resolved') throw new UserError('Incident is already resolved', 409);
  const msg = (customMessage || '').trim();
  if (msg.length > 300) throw new UserError('Message is too long (max 300 characters)');

  const rows = firstPerPhone(await incidentRecipients(id, ['open', 'linked']));
  const items = rows.map((r) => ({
    phone: r.phone,
    ticketId: r.id,
    body: msg ? `KORAFI: ${msg}` : t(r.language, 'sms.incident', incidentName(inc.category, r.language), inc.area),
  }));
  const summary = await sendMessages(items, { kind: 'broadcast', incidentId: id });
  await query(
    `UPDATE incidents SET broadcast_count = broadcast_count + 1, status = CASE WHEN status = 'possible' THEN 'investigating' ELSE status END WHERE id = $1`,
    [id],
  );
  changed('incident');
  return summary;
}

export async function resolveIncident(id) {
  const [inc] = await query('SELECT * FROM incidents WHERE id = $1', [id]);
  if (!inc) throw new UserError('Incident not found', 404);
  if (inc.status === 'resolved') throw new UserError('Incident is already resolved', 409);

  await query(`UPDATE incidents SET status = 'resolved', resolved_at = now() WHERE id = $1`, [id]);
  const rows = await incidentRecipients(id, ['open', 'linked']);
  await query(`UPDATE tickets SET status = 'resolved', resolved_at = now() WHERE incident_id = $1 AND status IN ('open','linked')`, [id]);
  const items = firstPerPhone(rows).map((r) => ({
    phone: r.phone,
    ticketId: r.id,
    body: t(r.language, 'sms.resolved', incidentName(inc.category, r.language), inc.area, r.code),
  }));
  const summary = await sendMessages(items, { kind: 'resolution', incidentId: id });
  changed('incident');
  return summary;
}

/* ───────────── tickets ───────────── */

export async function createReport({ phone, category, area, channel = 'ussd', recordingUrl = null }) {
  if (!config.categories.includes(category)) throw new UserError('Unknown category');
  if (area !== 'Other' && !config.areas.includes(area)) throw new UserError('Unknown area');

  const out = await exclusive(async () => {
    const [dup] = await query(
      `SELECT * FROM tickets WHERE phone = $1 AND category = $2 AND area = $3
       AND status IN ('open','linked') AND created_at >= $4::timestamptz ORDER BY id DESC LIMIT 1`,
      [phone, category, area, ago(DUPLICATE_WINDOW_MIN)],
    );
    if (dup) return { ticket: dup, duplicate: true, incident: null, incidentCreated: false };

    await ensureCustomer(phone);
    const [row] = await query(
      `INSERT INTO tickets (code, phone, category, area, channel, recording_url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      ['TMP-' + Math.random().toString(36).slice(2), phone, category, area, channel, recordingUrl],
    );
    await query('UPDATE tickets SET code = $2 WHERE id = $1', [row.id, 'KF' + (1000 + row.id)]);
    let [ticket] = await query('SELECT * FROM tickets WHERE id = $1', [row.id]);
    const { incident, created } = await detectIncident(ticket);
    [ticket] = await query('SELECT * FROM tickets WHERE id = $1', [row.id]);
    return { ticket, duplicate: false, incident, incidentCreated: created };
  });

  changed(out.duplicate ? 'noop' : 'ticket');
  if (out.duplicate) return { ...out, sms: Promise.resolve(null) };

  // Confirmation SMS never blocks the caller (USSD must answer quickly).
  const lang = await getLang(phone);
  const body = out.incident
    ? t(lang, 'sms.ticketIncident', out.ticket.code, incidentName(out.ticket.category, lang), out.ticket.area)
    : t(lang, 'sms.ticket', out.ticket.code);
  const sms = sendMessages([{ phone, body, ticketId: out.ticket.id }], { kind: 'ticket', incidentId: out.incident?.id }).catch((e) =>
    console.error('[korafi] ticket SMS failed:', e.message),
  );
  return { ...out, sms };
}

export async function attachRecording(code, phone, url) {
  await query('UPDATE tickets SET recording_url = $3 WHERE code = $1 AND phone = $2', [code, phone, url]);
  changed('ticket');
}

export const recentTickets = (phone, limit = 3) =>
  query('SELECT * FROM tickets WHERE phone = $1 ORDER BY id DESC LIMIT $2', [phone, limit]);

export async function findTicket(phone, code) {
  const [tk] = await query('SELECT * FROM tickets WHERE phone = $1 AND code = $2', [phone, String(code).toUpperCase()]);
  return tk || null;
}

export function ticketStatusText(ticket, lang) {
  return STATUS_LABELS[ticket.status]?.[lang] || ticket.status;
}

export async function pendingConfirmation(phone) {
  const [tk] = await query(
    `SELECT * FROM tickets WHERE phone = $1 AND status = 'resolved' ORDER BY resolved_at DESC, id DESC LIMIT 1`,
    [phone],
  );
  return tk || null;
}

/** Resolve a single ticket that is not part of an incident (or one-off from the dashboard). */
export async function resolveTicket(id) {
  const [tk] = await query('SELECT * FROM tickets WHERE id = $1', [id]);
  if (!tk) throw new UserError('Ticket not found', 404);
  if (!['open', 'linked'].includes(tk.status)) throw new UserError('Ticket is not open', 409);
  await query(`UPDATE tickets SET status = 'resolved', resolved_at = now() WHERE id = $1`, [id]);
  const lang = await getLang(tk.phone);
  const summary = await sendMessages(
    [{ phone: tk.phone, ticketId: id, body: t(lang, 'sms.resolved', incidentName(tk.category, lang), tk.area, tk.code) }],
    { kind: 'resolution', incidentId: tk.incident_id },
  );
  changed('ticket');
  return summary;
}

/**
 * Customer answers "was it fixed?". Yes → ticket confirmed + airtime reward. No → ticket disputed,
 * and an incident with enough disputes is re-opened.
 */
export async function confirmTicket(ticketId, yes) {
  const out = await exclusive(async () => {
    const [tk] = await query('SELECT * FROM tickets WHERE id = $1', [ticketId]);
    if (!tk || tk.status !== 'resolved') return { ok: false };
    if (yes) {
      await query(`UPDATE tickets SET status = 'confirmed', confirmed_at = now() WHERE id = $1`, [ticketId]);
      const reward = await issueReward(tk);
      return { ok: true, yes: true, ticket: tk, reward };
    }
    await query(`UPDATE tickets SET status = 'disputed', confirmed_at = now() WHERE id = $1`, [ticketId]);
    let reopened = false;
    if (tk.incident_id) {
      const [inc] = await query('SELECT status FROM incidents WHERE id = $1', [tk.incident_id]);
      const [d] = await query(`SELECT COUNT(*)::int AS n FROM tickets WHERE incident_id = $1 AND status = 'disputed'`, [tk.incident_id]);
      if (inc?.status === 'resolved' && d.n >= config.incident.threshold) {
        await query(`UPDATE incidents SET status = 'investigating', resolved_at = NULL WHERE id = $1`, [tk.incident_id]);
        reopened = true;
      }
    }
    return { ok: true, yes: false, ticket: tk, reopened };
  });
  if (out.ok) changed('confirmation');
  return out;
}

async function issueReward(ticket) {
  const amount = config.reward;
  if (!amount || amount <= 0) return { status: 'none', amount: 0 };
  const [today] = await query(
    `SELECT COUNT(*)::int AS n FROM rewards WHERE phone = $1 AND status <> 'failed' AND created_at >= $2::timestamptz`,
    [ticket.phone, ago(24 * 60)],
  );
  if (today.n >= config.maxRewardsPerDay) {
    await query(`INSERT INTO rewards (ticket_id, phone, amount, currency, status, detail) VALUES ($1,$2,$3,$4,'limited','daily limit reached')`, [ticket.id, ticket.phone, amount, config.currency]);
    return { status: 'limited', amount: 0 };
  }
  const [row] = await query(
    `INSERT INTO rewards (ticket_id, phone, amount, currency) VALUES ($1,$2,$3,$4) ON CONFLICT (ticket_id) DO NOTHING RETURNING id`,
    [ticket.id, ticket.phone, amount, config.currency],
  );
  if (!row) return { status: 'duplicate', amount: 0 };
  const res = await sendAirtime(ticket.phone, amount);
  await query('UPDATE rewards SET status = $2, detail = $3 WHERE id = $1', [row.id, res.status, res.detail]);
  changed('reward');
  return { status: res.status, amount: res.status === 'failed' ? 0 : amount };
}

export const rewardText = (reward) => (reward.amount ? money(reward.amount) : '');

/* ───────────── queries for the dashboard ───────────── */

export async function listIncidents(status) {
  const where = status === 'active' ? "WHERE status IN ('possible','investigating')" : status === 'resolved' ? "WHERE status = 'resolved'" : '';
  return query(`SELECT * FROM incidents ${where} ORDER BY (status = 'resolved'), report_count DESC, id DESC LIMIT 100`);
}

export async function incidentDetail(id) {
  const [incident] = await query('SELECT * FROM incidents WHERE id = $1', [id]);
  if (!incident) throw new UserError('Incident not found', 404);
  const tickets = await query('SELECT * FROM tickets WHERE incident_id = $1 ORDER BY id DESC LIMIT 200', [id]);
  const messages = await query('SELECT * FROM messages WHERE incident_id = $1 ORDER BY id DESC LIMIT 50', [id]);
  return { incident, tickets, messages, categoryLabel: categoryLabel(incident.category, 'en') };
}
