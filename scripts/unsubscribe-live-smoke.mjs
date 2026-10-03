// One-time diagnostics only. Never logs secret or signed tokens; never sends email.
// A failure prints a fixed stage label and exits successfully to avoid taking down production.
import { createUnsubscribeToken } from '../src/modules/outreach/unsubscribe-token.mjs';

const testEmail = 'vyro-unsubscribe-smoke-20261003@example.invalid';
const origin = 'https://vyro-unsubscribe-web-production.up.railway.app';
const report = (stage, result) => console.log('VYRO_SMOKE ' + stage + ' ' + result);
async function post(token) {
  const res = await fetch(new URL('/api/unsubscribe', origin), {
    method: 'POST', body: new URLSearchParams({ token }),
    redirect: 'manual', signal: AbortSignal.timeout(15000)
  });
  return res.status;
}
async function main() {
  if (process.env.PUBLIC_APP_ORIGIN !== origin) {
    report('configuration', 'ORIGIN_MISMATCH'); return;
  }
  if (typeof process.env.UNSUBSCRIBE_SECRET !== 'string' || process.env.UNSUBSCRIBE_SECRET.length < 32) {
    report('configuration', 'SECRET_MISSING_OR_SHORT'); return;
  }
  report('configuration', 'OK');
  let invalid;
  try { invalid = await post('invalid.smoke-token'); }
  catch { report('network', 'REQUEST_FAILED'); return; }
  report('invalid_token', String(invalid));
  if (invalid !== 400) return;
  const token = createUnsubscribeToken(testEmail, process.env.UNSUBSCRIBE_SECRET);
  let valid;
  try { valid = await post(token); }
  catch { report('valid_token_network', 'REQUEST_FAILED'); return; }
  report('valid_token', String(valid));
  if (valid !== 200) return;
  let repeat;
  try { repeat = await post(token); }
  catch { report('repeat_network', 'REQUEST_FAILED'); return; }
  report('repeat_token', String(repeat));
  if (repeat === 200) report('result', 'PASS');
}
await main().catch(() => report('result', 'UNEXPECTED_ERROR'));
