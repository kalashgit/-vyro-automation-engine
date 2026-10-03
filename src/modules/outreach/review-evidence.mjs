// Evidence checks for operator-reviewed contacts. Reviewing is not an automatic
// assertion of legal permission to send marketing or of mailbox deliverability.
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export function normalizeBusinessEmail(value) {
  if (typeof value !== 'string' || !EMAIL.test(value.trim()) || value.trim().length > 254) throw new Error('INVALID_EMAIL');
  return value.trim().toLowerCase();
}
export function validateOfficialEvidence(urlValue, canonicalDomain) {
  if (typeof canonicalDomain !== 'string' || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(canonicalDomain)) throw new Error('CANONICAL_DOMAIN_REQUIRED');
  let url;
  try { url = new URL(urlValue); } catch { throw new Error('INVALID_EVIDENCE_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.href.length > 2048) {
    throw new Error('INVALID_EVIDENCE_URL');
  }
  const host = url.hostname.toLowerCase();
  if (host !== canonicalDomain && host !== 'www.' + canonicalDomain) throw new Error('EVIDENCE_MUST_USE_OFFICIAL_DOMAIN');
  return url.href;
}
export function validateReviewConfirmation(form) {
  if (form.get('exactEmailObserved') !== 'yes' || form.get('businessIdentityConfirmed') !== 'yes'
    || form.get('businessRelevanceConfirmed') !== 'yes') {
    throw new Error('REVIEW_CONFIRMATION_REQUIRED');
  }
  // Local review evidence is not proof of legal entitlement to contact a recipient.
  return true;
}
