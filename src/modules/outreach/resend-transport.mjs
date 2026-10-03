// Deliberately not wired to any worker or schedule. Call only through sendGuardedOutreach.
// No implicit retries: caller must record outcomes before attempting another send.
export function createResendTransport(environment = process.env, fetchImpl = fetch) {
  return async function send(payload) {
    if (environment.OUTREACH_SENDING_ENABLED !== 'true') throw new Error('OUTREACH_SENDING_DISABLED');
    const key = environment.RESEND_API_KEY;
    if (!key || typeof key !== 'string') throw new Error('RESEND_API_KEY_REQUIRED');
    if (!payload || payload.from !== 'VYRO <sales@vyro.gr>' ||
      !Array.isArray(payload.to) || payload.to.length !== 1 ||
      !payload.reply_to || !payload.html || !payload.text || !payload.subject) {
      throw new Error('INVALID_GUARDED_PAYLOAD');
    }
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error('RESEND_DELIVERY_REQUEST_FAILED');
    const result = await response.json();
    if (typeof result?.id !== 'string') throw new Error('RESEND_ID_MISSING');
    return { id: result.id };
  };
}
