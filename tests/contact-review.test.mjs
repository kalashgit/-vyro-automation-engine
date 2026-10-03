import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBusinessEmail, validateOfficialEvidence, validateReviewConfirmation }
  from '../src/modules/outreach/review-evidence.mjs';

test('normalizes exact business email and rejects invalid input', () => {
  assert.equal(normalizeBusinessEmail('  Sales@Example.GR  '), 'sales@example.gr');
  assert.throws(() => normalizeBusinessEmail('none'));
  assert.throws(() => normalizeBusinessEmail('a@b.com\r\nCc: victim@b.com'));
});
test('requires exact official HTTPS domain and excludes impostors', () => {
  assert.equal(validateOfficialEvidence('https://www.example.gr/contact', 'example.gr'), 'https://www.example.gr/contact');
  for (const u of [
    'http://example.gr/contact', 'https://example.gr.attacker.com/contact',
    'https://evil.example.gr/contact', 'https://example.gr:8443/contact',
    'https://user:pass@example.gr/contact', 'https://google.com/contact',
    'https://example.gr/contact#secret',
  ]) assert.throws(() => validateOfficialEvidence(u, 'example.gr'), u);
  assert.throws(() => validateOfficialEvidence('https://example.gr', null));
});
test('manual review requires all three independently affirmed checks', () => {
  const approved = {
    exactEmailObserved: true, businessIdentityConfirmed: true, businessRelevanceConfirmed: true
  };
  assert.equal(validateReviewConfirmation(approved), true);
  for (const key of Object.keys(approved)) {
    assert.throws(() => validateReviewConfirmation({ ...approved, [key]: false }));
  }
  assert.throws(() => validateReviewConfirmation(null));
});
