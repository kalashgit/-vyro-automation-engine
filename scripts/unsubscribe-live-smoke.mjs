// Run only as a one-time, controlled Railway pre-deploy smoke test.
// Uses the service's existing UNSUBSCRIBE_SECRET without logging it or any signed token.
// It does not send email and can suppress only this reserved invalid-domain address.
import { createUnsubscribeToken } from '../src/modules/outreach/unsubscribe-token.mjs';

const testEmail = 'vyro-unsubscribe-smoke-20261003@example.invalid';
const approvedOrigin = 'https://vyro-unsubscribe-web-production.up.railway.app';

if (process.env.PUBLIC_APP_ORIGIN !== approvedOrigin) {
  throw new Error('SMOKE_ABORT: Unexpected production origin');
}
if (typeof process.env.UNSUBSCRIBE_SECRET !== 'string' || process.env.UNSUBSCRIBE_SECRET.length < 32) {
  throw new Error('SMOKE_ABORT: Signing secret unavailable');
}
const url = new URL('/api/unsubscribe', approvedOrigin);
async function post(token) {
  const response = await fetch(url, {
    method: 'POST',
    body: new URLSearchParams({ token }),
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  return response.status;
}
const badStatus = await post('invalid.smoke-token');
if (badStatus !== 400) throw new Error('SMOKE_FAIL: Invalid token not rejected');
const validToken = createUnsubscribeToken(testEmail, process.env.UNSUBSCRIBE_SECRET);
const validStatus = await post(validToken);
if (validStatus !== 200) throw new Error('SMOKE_FAIL: Valid unsubscribe did not succeed');
const repeatStatus = await post(validToken);
if (repeatStatus !== 200) throw new Error('SMOKE_FAIL: Repeated unsubscribe not idempotent');
console.log('VYRO_UNSUBSCRIBE_SMOKE_PASS: invalid=400 valid=200 repeat=200; verify dummy suppression row in Neon.');
