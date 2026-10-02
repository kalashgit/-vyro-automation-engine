// Must be called immediately before each promotional email is sent.
// Database errors reject sending rather than assuming an address is safe.
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export async function assertSendEligible({ email, prospect, contacts, db }) {
  if (typeof email !== 'string' || !EMAIL.test(email)) throw new Error('INVALID_EMAIL');
  const address = email.trim().toLowerCase();
  if (!db || typeof db.query !== 'function') throw new Error('SUPPRESSION_DATABASE_REQUIRED');
  if (prospect?.identity_status !== 'certified' || prospect?.verification_status !== 'verified' || prospect?.suppression_status !== 'passed' || prospect?.relevance_status !== 'relevant' || prospect?.contactability_status !== 'contactable') throw new Error('PROSPECT_NOT_APPROVED');
  const matching = Array.isArray(contacts) && contacts.some(c => c?.channel === 'email' && c?.verification_status === 'verified' && c?.value?.trim().toLowerCase() === address && /^https?:\/\//.test(c?.source_url || ''));
  if (!matching) throw new Error('NO_VERIFIED_MATCHING_EMAIL');
  const result = await db.query('SELECT 1 FROM email_suppressions WHERE email_normalized = $1 LIMIT 1', [address]);
  if (result.rows.length) throw new Error('EMAIL_SUPPRESSED');
  return { eligible: true, email: address };
}
