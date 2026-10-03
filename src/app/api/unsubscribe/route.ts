import { getDatabasePool, withTransaction } from '@/modules/database/client';
import { verifyUnsubscribeToken } from '@/modules/outreach/unsubscribe-token.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const secret = process.env.UNSUBSCRIBE_SECRET;
  if (!secret || secret.length < 32) return new Response('Unavailable', { status: 503 });
  if (Number(request.headers.get('content-length') || 0) > 4096) return new Response('Invalid request', { status: 413 });
  let token: unknown;
  try { token = (await request.formData()).get('token'); }
  catch { return new Response('Invalid request', { status: 400 }); }
  const email = verifyUnsubscribeToken(token, secret);
  if (!email) return new Response('Invalid link', { status: 400 });
  try {
    await withTransaction(getDatabasePool(), async (client) => {
      await client.query('INSERT INTO email_suppressions (email_normalized) VALUES ($1) ON CONFLICT DO NOTHING', [email]);
      await client.query("UPDATE prospects SET suppression_status = 'suppressed', suppression_reason = 'recipient_unsubscribed', suppression_checked_at = now(), updated_at = now() WHERE record_id IN (SELECT record_id FROM contact_points WHERE channel = 'email' AND lower(btrim(value)) = $1)", [email]);
    });
    return new Response('You have been unsubscribed from VYRO commercial emails.', { headers: { 'Cache-Control': 'no-store' } });
  } catch { return new Response('Service temporarily unavailable', { status: 503 }); }
}
