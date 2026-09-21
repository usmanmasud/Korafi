import { config } from './config.js';

/**
 * Thin Africa's Talking client (SMS + Airtime). USSD and Voice are inbound
 * webhooks and live in src/routes. With no AT_API_KEY the client runs in
 * dry-run mode: nothing leaves the machine, calls return status "simulated".
 */

/** Demo numbers created by the dashboard simulator (+23400…) never reach the network. */
export const isSynthetic = (phone) => phone.startsWith('+23400');

const host = () => (config.at.sandbox ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com');

async function post(path, fields) {
  const res = await fetch(host() + path, {
    method: 'POST',
    headers: {
      apiKey: config.at.apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ username: config.at.username, ...fields }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Africa's Talking ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`Africa's Talking ${res.status}: ${text.slice(0, 200)}`);
  return json;
}

/**
 * Send one SMS body to many recipients.
 * @returns {Promise<Array<{phone:string,status:'sent'|'failed'|'simulated',providerId:string|null,detail:string}>>}
 */
export async function sendSms(all, message) {
  if (!all.length) return [];
  const results = all.filter(isSynthetic).map((phone) => ({ phone, status: 'simulated', providerId: null, detail: 'synthetic demo number' }));
  const recipients = all.filter((p) => !isSynthetic(p));
  if (!recipients.length) return results;
  if (!config.at.live) {
    return results.concat(recipients.map((phone) => ({ phone, status: 'simulated', providerId: null, detail: 'dry-run (no AT_API_KEY)' })));
  }
  for (let i = 0; i < recipients.length; i += 100) {
    const chunk = recipients.slice(i, i + 100);
    try {
      const fields = { to: chunk.join(','), message };
      if (config.senderId) fields.from = config.senderId;
      const json = await post('/version1/messaging', fields);
      const got = json?.SMSMessageData?.Recipients || [];
      for (const phone of chunk) {
        const r = got.find((x) => x.number === phone);
        if (r && [100, 101, 102].includes(Number(r.statusCode))) {
          results.push({ phone, status: 'sent', providerId: r.messageId || null, detail: r.status || 'Sent' });
        } else {
          results.push({ phone, status: 'failed', providerId: null, detail: r?.status || json?.SMSMessageData?.Message || 'No recipient status returned' });
        }
      }
    } catch (err) {
      for (const phone of chunk) results.push({ phone, status: 'failed', providerId: null, detail: err.message });
    }
  }
  return results;
}

/** Send airtime to a single number. amount is in config.currency. */
export async function sendAirtime(phone, amount) {
  if (isSynthetic(phone)) return { status: 'simulated', detail: 'synthetic demo number' };
  if (!config.at.live) {
    return { status: 'simulated', detail: 'dry-run (no AT_API_KEY)' };
  }
  try {
    const recipients = JSON.stringify([{ phoneNumber: phone, amount: `${config.currency} ${amount}` }]);
    const json = await post('/version1/airtime/send', { recipients });
    const r = json?.responses?.[0];
    if (r && r.status === 'Sent') return { status: 'sent', detail: `requestId ${r.requestId || '-'}` };
    return { status: 'failed', detail: r?.errorMessage && r.errorMessage !== 'None' ? r.errorMessage : json?.errorMessage || 'Airtime not sent' };
  } catch (err) {
    return { status: 'failed', detail: err.message };
  }
}

export const atMode = () => (!config.at.live ? 'dry-run' : config.at.sandbox ? 'sandbox' : 'live');
