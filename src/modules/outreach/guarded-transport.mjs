// No caller is wired to this module. Every send requires an explicit enabled flag
// plus live prospect verification, a suppression query, and a working unsubscribe URL.
import { assertSendEligible } from './send-eligibility.mjs';
import { buildUnsubscribeUrl } from './unsubscribe-token.mjs';
import { renderVyroEmail } from './email-template.mjs';
import { addReplyRouting } from './reply-routing.mjs';

export async function sendGuardedOutreach({ email, prospect, contacts, db, bodyText, subject, send, environment = process.env }) {
  if (environment.OUTREACH_SENDING_ENABLED !== 'true') throw new Error('OUTREACH_SENDING_DISABLED');
  if (typeof send !== 'function') throw new Error('EMAIL_TRANSPORT_REQUIRED');
  if (typeof subject !== 'string' || !subject.trim()) throw new Error('EMAIL_SUBJECT_REQUIRED');
  if (!environment.UNSUBSCRIBE_SECRET || !environment.PUBLIC_APP_ORIGIN) throw new Error('UNSUBSCRIBE_NOT_CONFIGURED');
  const { email: approvedEmail } = await assertSendEligible({ email, prospect, contacts, db });
  const unsubscribeUrl = buildUnsubscribeUrl(approvedEmail, environment.UNSUBSCRIBE_SECRET, environment.PUBLIC_APP_ORIGIN);
  const content = renderVyroEmail({ bodyText, unsubscribeUrl });
  const payload = addReplyRouting({
    from: 'VYRO <sales@vyro.gr>',
    to: [approvedEmail],
    subject: subject.trim(),
    text: content.text,
    html: content.html
  }, environment);
  // Only the verified, approved address can reach the injected transport.
  return send(payload);
}
