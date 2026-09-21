import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.KORAFI_DATA_DIR = 'memory';
process.env.AT_API_KEY = ''; // dry-run: no network
process.env.DASHBOARD_PASSWORD = 'test-pass';
process.env.DEFAULT_REWARD = '50';

const { initDb, closeDb, query } = await import('../src/db.js');
const { createApp } = await import('../src/server.js');

let server, base, cookie;

const form = (o) => new URLSearchParams(o).toString();
const ussd = async (phone, text) => {
  const r = await fetch(base + '/at/ussd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ sessionId: 's1', serviceCode: '*384*1#', phoneNumber: phone, text }),
  });
  return r.text();
};
const api = async (path, body, method = body ? 'POST' : 'GET') => {
  const r = await fetch(base + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

before(async () => {
  await initDb();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-pass' }),
  });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  server.close();
  await closeDb();
});

test('dashboard API requires a session', async () => {
  const r = await fetch(base + '/api/overview');
  assert.equal(r.status, 401);
  const bad = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) });
  assert.equal(bad.status, 401);
});

test('USSD: menus, report → ticket, duplicate protection', async () => {
  assert.match(await ussd('08030000001', ''), /^CON KORAFI/);
  assert.match(await ussd('08030000001', '1'), /^CON Zaɓi matsala/);
  assert.match(await ussd('08030000001', '1*3'), /^CON Zaɓi unguwa/);
  const done = await ussd('08030000001', '1*3*1');
  assert.match(done, /^END An karɓi rahotonka\.\nTicket: #KF\d+/);
  assert.match(await ussd('08030000001', '1*3*1'), /^END Ka riga ka bayar/);
  assert.match(await ussd('08030000001', '2'), /Matsalar network, Kabuga/);
  assert.match(await ussd('08030000001', '1*9'), /^END Zaɓin bai dace/);
  const msgs = await query(`SELECT * FROM messages WHERE phone = '+2348030000001' AND kind = 'ticket'`);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].body, /^KORAFI: An karɓi rahotonka/);
  assert.equal(msgs[0].status, 'simulated');
});

test('Incident engine: same problem + same area + window → incident; other areas do not cluster', async () => {
  await ussd('08030000002', '1*3*1');
  let ov = (await api('/overview')).json;
  assert.equal(ov.incidents.length, 0, 'two customers is below the threshold');
  await ussd('08030000003', '1*3*2'); // different area
  assert.equal((await api('/overview')).json.incidents.length, 0);
  await ussd('08030000004', '1*3*1'); // 3rd distinct customer in Kabuga
  ov = (await api('/overview')).json;
  assert.equal(ov.incidents.length, 1);
  const inc = ov.incidents[0];
  assert.equal(inc.area, 'Kabuga');
  assert.equal(inc.category, 'network');
  assert.equal(inc.status, 'possible');
  assert.equal(inc.customer_count, 3);
  // A later report joins the open incident and the SMS says so.
  await ussd('08030000005', '1*3*1');
  const detail = (await api(`/incidents/${inc.id}`)).json;
  assert.equal(detail.incident.report_count, 4);
  const [m] = await query(`SELECT body FROM messages WHERE phone = '+2348030000005' AND kind = 'ticket'`);
  assert.match(m.body, /Ana fama da matsalar network a Kabuga/);
});

test('Broadcast → resolve → confirm via USSD → airtime reward (idempotent)', async () => {
  const inc = (await api('/overview')).json.incidents[0];
  const b = await api(`/incidents/${inc.id}/broadcast`, {});
  assert.equal(b.status, 200);
  assert.equal(b.json.total, 4);
  assert.equal((await api(`/incidents/${inc.id}`)).json.incident.status, 'investigating');

  const custom = await api(`/incidents/${inc.id}/broadcast`, { message: 'Ana gyara layin.' });
  assert.equal(custom.json.total, 4);
  const [cm] = await query(`SELECT body FROM messages WHERE body LIKE '%Ana gyara layin.%' LIMIT 1`);
  assert.equal(cm.body, 'KORAFI: Ana gyara layin.');

  const r = await api(`/incidents/${inc.id}/resolve`, {});
  assert.equal(r.status, 200);
  assert.equal((await api(`/incidents/${inc.id}/resolve`, {})).status, 409);

  assert.match(await ussd('08030000002', '3'), /^CON An gyara matsalar\?/);
  const yes = await ussd('08030000002', '3*1');
  assert.match(yes, /^END Na gode da tabbatar da gyaran\. An ƙara ₦50 airtime/);
  assert.match(await ussd('08030000002', '3'), /^END Babu wani rahoto/);
  const rewards = await query(`SELECT * FROM rewards WHERE phone = '+2348030000002'`);
  assert.equal(rewards.length, 1);
  assert.equal(rewards[0].status, 'simulated');

  // "No" is recorded and does not pay out.
  assert.match(await ussd('08030000004', '3*2'), /^END Mun gode/);
  assert.equal((await query(`SELECT * FROM rewards WHERE phone = '+2348030000004'`)).length, 0);
});

test('SMS keywords: confirm reply, status lookup, help', async () => {
  const sms = (from, text) =>
    fetch(base + '/at/sms', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ from, to: '22141', text }) });
  await sms('+2348030000005', '1');
  assert.equal((await query(`SELECT * FROM rewards WHERE phone = '+2348030000005'`)).length, 1);
  const [tk] = await query(`SELECT code FROM tickets WHERE phone = '+2348030000001'`);
  await sms('+2348030000001', `STATUS ${tk.code}`);
  const [reply] = await query(`SELECT body FROM messages WHERE phone = '+2348030000001' AND kind = 'reply' ORDER BY id DESC LIMIT 1`);
  assert.match(reply.body, new RegExp(`Ticket #${tk.code}`));
});

test('Language switch and English menu', async () => {
  assert.match(await ussd('08030000009', '5'), /^END Language changed to English/);
  assert.match(await ussd('08030000009', ''), /1\. Report a problem/);
});

test('Voice: language → menu → category → area → ticket; recording attaches', async () => {
  const voice = async (q, body) => {
    const r = await fetch(`${base}/at/voice?${new URLSearchParams(q)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ isActive: '1', callerNumber: '+2348030000010', ...body }),
    });
    return r.text();
  };
  assert.match(await voice({}, {}), /<GetDigits[^>]*step=lang/);
  assert.match(await voice({ step: 'lang' }, { dtmfDigits: '1' }), /step=menu/);
  assert.match(await voice({ step: 'menu' }, { dtmfDigits: '1' }), /step=cat/);
  assert.match(await voice({ step: 'cat' }, { dtmfDigits: '2' }), /cat=water/);
  const done = await voice({ step: 'area', cat: 'water' }, { dtmfDigits: '2' });
  const code = done.match(/code=(KF\d+)/)[1];
  assert.match(done, /<Say[^>]*>An karɓi rahotonka/);
  assert.match(await voice({ step: 'rec', code }, { dtmfDigits: '1' }), /<Record /);
  await voice({ step: 'recorded', code }, { recordingUrl: 'https://example.com/r.mp3' });
  const [tk] = await query('SELECT * FROM tickets WHERE code = $1', [code]);
  assert.equal(tk.channel, 'voice');
  assert.equal(tk.area, 'Hotoro');
  assert.equal(tk.recording_url, 'https://example.com/r.mp3');
});

test('Simulator uses synthetic numbers; manual incident; CSV export', async () => {
  const s = await api('/simulate', { category: 'power', area: 'Tarauni', count: 5 });
  assert.equal(s.json.created, 5);
  const ov = (await api('/overview')).json;
  const inc = ov.incidents.find((i) => i.category === 'power' && i.area === 'Tarauni');
  assert.ok(inc);
  assert.equal(inc.confidence, 'MEDIUM');
  assert.equal((await api('/incidents', { category: 'power', area: 'Tarauni' })).status, 409);
  assert.equal((await api('/simulate', { category: 'nope', area: 'Tarauni' })).status, 400);
  const csv = await fetch(base + '/api/export/reports.csv', { headers: { cookie } });
  assert.match(await csv.text(), /^code,phone,category/);
});

test('Webhook key is enforced when configured', async () => {
  const { config } = await import('../src/config.js');
  config.webhookKey = 'k3y';
  const bad = await fetch(base + '/at/ussd', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ phoneNumber: '0803', text: '' }) });
  assert.equal(bad.status, 403);
  const ok = await fetch(base + '/at/ussd?key=k3y', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ phoneNumber: '08030000001', text: '' }) });
  assert.equal(ok.status, 200);
  config.webhookKey = '';
});
