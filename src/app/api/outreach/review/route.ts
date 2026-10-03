import { requireAdmin } from '@/lib/admin-auth';
import { getDatabasePool, withTransaction } from '@/modules/database/client';
import { normalizeBusinessEmail, validateOfficialEvidence, validateReviewConfirmation } from '@/modules/outreach/review-evidence.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Staff-only review. The operator must personally inspect the official page;
// this endpoint never fetches a URL or automatically claims an email is verified.
export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const result = await getDatabasePool().query(
      `SELECT p.record_id, p.normalized_company_name, p.canonical_domain, p.country,
              p.identity_status, p.verification_status, p.suppression_status,
              p.relevance_status, p.contactability_status,
              count(c.contact_id)::integer AS email_contacts
         FROM prospects p LEFT JOIN contact_points c
           ON c.record_id=p.record_id AND c.channel='email'
        WHERE p.suppression_status='unchecked'\n        GROUP BY p.record_id ORDER BY p.created_at, p.record_id LIMIT 50`
    );
    return Response.json({ prospects: result.rows }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: 'REVIEW_DATABASE_UNAVAILABLE' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  if (Number(request.headers.get('content-length') || 0) > 8192) return Response.json({ error: 'REQUEST_TOO_LARGE' }, { status: 413 });
  let input: Record<string, unknown>;
  try {
    input = await request.json();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
  } catch {
    return Response.json({ error: 'INVALID_REVIEW' }, { status: 400 });
  }
  const recordId = input.recordId;
  if (typeof recordId !== 'string' || !/^[A-Z0-9]+-[A-Z0-9-]+$/.test(recordId) || recordId.length > 200) {
    return Response.json({ error: 'INVALID_RECORD_ID' }, { status: 400 });
  }
  try { validateReviewConfirmation(input); }
  catch { return Response.json({ error: 'REVIEW_CONFIRMATION_REQUIRED' }, { status: 400 }); }
  let email: string;
  try { email = normalizeBusinessEmail(input.email); }
  catch { return Response.json({ error: 'INVALID_EMAIL' }, { status: 400 }); }

  try {
    const result = await withTransaction(getDatabasePool(), async (client) => {
      const { rows: [p] } = await client.query(
        'SELECT record_id, canonical_domain, identity_status FROM prospects WHERE record_id=$1 FOR UPDATE', [recordId]);
      if (!p) return { status: 404, error: 'UNKNOWN_RECORD_ID' };
      if (p.identity_status !== 'certified') return { status: 409, error: 'IDENTITY_NOT_READY' };
      let evidenceUrl: string;
      try { evidenceUrl = validateOfficialEvidence(input.evidenceUrl, p.canonical_domain); }
      catch { return { status: 400, error: 'OFFICIAL_EVIDENCE_REQUIRED' }; }
      await client.query(
        `INSERT INTO contact_points(record_id,channel,value,source_url,verification_status,verification_method,verified_at)
         VALUES($1,'email',$2,$3,'verified','human_checked_official_website',now())
         ON CONFLICT(record_id,channel,value) DO UPDATE
           SET source_url=excluded.source_url, verification_status='verified',
               verification_method=excluded.verification_method,verified_at=now()`,
        [recordId, email, evidenceUrl]
      );
      await client.query(
        `UPDATE prospects
           SET verification_status='verified',
               verification_evidence=jsonb_build_object('method','human_checked_official_website','evidence_url',$2::text,'reviewed_at',now()),
               verified_at=now(), relevance_status='relevant', contactability_status='contactable',
               suppression_status='unchecked', suppression_reason=NULL, suppression_checked_at=NULL, updated_at=now()
         WHERE record_id=$1`, [recordId, evidenceUrl]
      );
      // Always queue a fresh check for this review. Existing leased checks may
      // finish before this transaction commits, so relying on one pending job
      // could leave a re-reviewed prospect indefinitely unchecked.
      await client.query(
        `INSERT INTO jobs(type,payload,idempotency_key)
         VALUES('suppression_check',jsonb_build_object('recordId',$1::text),$2)`,
        [recordId, 'suppression-review-' + crypto.randomUUID()]
      );
      return { status: 202, result: 'REVIEW_RECORDED_SUPPRESSION_QUEUED' };
    });
    if ('error' in result) return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ status: result.result }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: 'REVIEW_DATABASE_UNAVAILABLE' }, { status: 503 });
  }
}
