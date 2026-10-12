import { requireAdmin } from '@/lib/admin-auth';
import { getDatabasePool } from '@/modules/database/client';
import { EnrichmentBatchError, previewEnrichmentBatch, queueEnrichmentBatch } from '@/modules/enrichment/batch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  if (Number(request.headers.get('content-length') || 0) > 8192) {
    return Response.json({ error: 'REQUEST_TOO_LARGE' }, { status: 413, headers: { 'Cache-Control': 'no-store' } });
  }
  const origin = request.headers.get('origin');
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
    return Response.json({ error: 'CROSS_ORIGIN_REQUEST' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  let body: Record<string, unknown>;
  try {
    const input = await request.json();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    body = input as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'INVALID_BATCH' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  if (body.action !== 'preview' && body.action !== 'enqueue') {
    return Response.json({ error: 'INVALID_ACTION' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const pool = getDatabasePool();
    const result = body.action === 'preview'
      ? await previewEnrichmentBatch(pool, body)
      : await queueEnrichmentBatch(pool, body);
    return Response.json(result, { status: body.action === 'preview' ? 200 : 202,
      headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof EnrichmentBatchError) {
      const status = error.code.startsWith('INVALID_') ? 400 : error.code === 'PROFILE_INDEX_INCOMPLETE' ? 409 : 409;
      return Response.json({ error: error.code, message: error.message }, { status, headers: { 'Cache-Control': 'no-store' } });
    }
    return Response.json({ error: 'ENRICHMENT_BATCH_UNAVAILABLE' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
