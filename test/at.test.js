import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AT_API_KEY = 'test-key';
process.env.AT_USERNAME = 'sandbox';

const { sendSms, sendAirtime } = await import('../src/at.js');
const { normalizePhone } = await import('../src/phone.js');

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: Object.fromEntries(new URLSearchParams(String(init.body))) });
    return new Response(JSON.stringify(handler(calls.at(-1))), { status: 201 });
  };
  return calls;
}

test('SMS goes to the sandbox host with apiKey header and per-recipient status', async () => {
  const calls = stubFetch(() => ({
    SMSMessageData: { Message: 'Sent to 1/2', Recipients: [
      { number: '+2348030000001', statusCode: 101, status: 'Success', messageId: 'ATXid_1' },
      { number: '+2348030000002', statusCode: 403, status: 'InvalidPhoneNumber' },
    ] },
  }));
  const res = await sendSms(['+2348030000001', '+2348030000002', '+23400123456789'], 'hello');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.sandbox.africastalking.com/version1/messaging');
  assert.equal(calls[0].init.headers.apiKey, 'test-key');
  assert.equal(calls[0].body.username, 'sandbox');
  assert.equal(calls[0].body.to, '+2348030000001,+2348030000002', 'synthetic numbers are never sent');
  assert.deepEqual(res.map((r) => r.status).sort(), ['failed', 'sent', 'simulated']);
  assert.equal(res.find((r) => r.status === 'sent').providerId, 'ATXid_1');
});

test('Airtime request uses "CUR amount" format and reports failures', async () => {
  let calls = stubFetch(() => ({ numSent: 1, responses: [{ status: 'Sent', requestId: 'ATQid_1', errorMessage: 'None' }] }));
  assert.equal((await sendAirtime('+2348030000001', 50)).status, 'sent');
  assert.equal(calls[0].url, 'https://api.sandbox.africastalking.com/version1/airtime/send');
  assert.deepEqual(JSON.parse(calls[0].body.recipients), [{ phoneNumber: '+2348030000001', amount: 'NGN 50' }]);

  stubFetch(() => ({ numSent: 0, responses: [{ status: 'Failed', errorMessage: 'Insufficient balance' }] }));
  const r = await sendAirtime('+2348030000001', 50);
  assert.equal(r.status, 'failed');
  assert.match(r.detail, /Insufficient balance/);
});

test('Phone normalisation', () => {
  assert.equal(normalizePhone('0803 000 0001'), '+2348030000001');
  assert.equal(normalizePhone('2348030000001'), '+2348030000001');
  assert.equal(normalizePhone('+2348030000001'), '+2348030000001');
  assert.equal(normalizePhone('abc'), null);
});
