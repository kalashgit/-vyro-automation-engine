import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResendTransport } from '../src/modules/outreach/resend-transport.mjs';

const payload = {
  from: 'VYRO <sales@vyro.gr>',
  to: ['approved@example.com'], subject: 'Test',
  reply_to: 'owner@example.com', text: 'Test', html: '<p>Test</p>'
};
test('sender stays disabled by default', async () => {
  let calls = 0;
  const send = createResendTransport({ RESEND_API_KEY: 'test' }, async () => { calls++; });
  await assert.rejects(send(payload), /OUTREACH_SENDING_DISABLED/);
  assert.equal(calls, 0);
});
test('enabled sender forwards only guarded payload', async () => {
  let request;
  const send = createResendTransport({ OUTREACH_SENDING_ENABLED: 'true', RESEND_API_KEY: 'test' },
    async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ id: 'test-message' }) };
    });
  assert.deepEqual(await send(payload), { id: 'test-message' });
  assert.equal(request.url, 'https://api.resend.com/emails');
  assert.deepEqual(JSON.parse(request.options.body), payload);
});
test('reject incomplete payload and never dispatch', async () => {
  let called = false;
  const send = createResendTransport({ OUTREACH_SENDING_ENABLED: 'true', RESEND_API_KEY: 'test' },
    async () => { called = true; });
  await assert.rejects(send({ ...payload, reply_to: null }), /INVALID_GUARDED_PAYLOAD/);
  assert.equal(called, false);
});
