import { EventEmitter } from 'node:events';
import { query } from '../db.js';
import { sendSms } from '../at.js';

/** Emits "change" whenever dashboard-visible data changes (drives the SSE live stream). */
export const bus = new EventEmitter();
bus.setMaxListeners(200);
export const changed = (what) => bus.emit('change', { what, at: Date.now() });

/**
 * Send SMS messages and log each one.
 * @param {Array<{phone:string, body:string, ticketId?:number}>} items
 * @param {{kind:string, incidentId?:number}} meta
 */
export async function sendMessages(items, { kind, incidentId = null }) {
  const byBody = new Map();
  for (const it of items) {
    if (!byBody.has(it.body)) byBody.set(it.body, []);
    byBody.get(it.body).push(it);
  }
  const summary = { total: items.length, sent: 0, simulated: 0, failed: 0 };
  for (const [body, group] of byBody) {
    let results;
    try {
      results = await sendSms(group.map((g) => g.phone), body);
    } catch (err) {
      results = group.map((g) => ({ phone: g.phone, status: 'failed', providerId: null, detail: err.message }));
    }
    for (const g of group) {
      const r = results.find((x) => x.phone === g.phone) || { status: 'failed', providerId: null, detail: 'no result' };
      summary[r.status] = (summary[r.status] || 0) + 1;
      await query(
        `INSERT INTO messages (phone, direction, kind, body, status, provider_id, detail, incident_id, ticket_id)
         VALUES ($1, 'out', $2, $3, $4, $5, $6, $7, $8)`,
        [g.phone, kind, body, r.status, r.providerId, r.detail, incidentId, g.ticketId ?? null],
      );
    }
  }
  changed('messages');
  return summary;
}

export async function logInbound(phone, kind, body) {
  await query(`INSERT INTO messages (phone, direction, kind, body, status) VALUES ($1, 'in', $2, $3, 'received')`, [phone, kind, body]);
  changed('messages');
}
