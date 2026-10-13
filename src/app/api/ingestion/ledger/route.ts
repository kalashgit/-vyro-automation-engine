import { requireAdmin } from '@/lib/admin-auth';
import { getDatabasePool } from '@/modules/database/client';
import { importVerifiedLedger } from '@/modules/ingestion/import.mjs';
import { validateLedger } from '@/modules/ingestion/ledger.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const MAX_FILE_BYTES = 2_000_000;

export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  if (Number(request.headers.get('content-length') || 0) > MAX_FILE_BYTES + 16_384) {
    return Response.json({ error: 'REQUEST_TOO_LARGE' }, { status: 413, headers: { 'Cache-Control': 'no-store' } });
  }
  const origin = request.headers.get('origin');
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
    return Response.json({ error: 'CROSS_ORIGIN_REQUEST' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  let form: FormData;
  try { form = await request.formData(); }
  catch { return Response.json({ error: 'INVALID_MULTIPART_FORM' }, { status: 400, headers: { 'Cache-Control': 'no-store' } }); }
  const action = form.get('action');
  const upload = form.get('file');
  if (action !== 'preview' && action !== 'import') {
    return Response.json({ error: 'INVALID_ACTION' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  if (!(upload instanceof File) || upload.size < 1 || upload.size > MAX_FILE_BYTES) {
    return Response.json({ error: 'INVALID_FILE', message: 'Choose a non-empty CSV file up to 2 MB.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  const filename = upload.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'worker-ledger.csv';
  let csv: string;
  try { csv = await upload.text(); }
  catch { return Response.json({ error: 'FILE_READ_FAILED' }, { status: 400, headers: { 'Cache-Control': 'no-store' } }); }

  let report;
  try { report = validateLedger(csv, { filename, requireSupervisorVerified: true, allowWorkerV51: true }); }
  catch (error) {
    return Response.json({ error: 'LEDGER_INVALID', message: error instanceof Error ? error.message : 'Ledger validation failed.' },
      { status: 422, headers: { 'Cache-Control': 'no-store' } });
  }
  const summary = { total: report.total, accepted: report.accepted.length, rejected: report.rejected.length,
    batches: report.batches.length, certification: report.certification,
    errors: report.rejected.slice(0, 50), sha256: report.sha256 };
  if (action === 'preview') return Response.json({ action, ...summary, writes: 0 }, { headers: { 'Cache-Control': 'no-store' } });
  if (report.rejected.length) return Response.json({ error: 'LEDGER_HAS_REJECTED_ROWS', ...summary }, { status: 422, headers: { 'Cache-Control': 'no-store' } });
  if (process.env.VYRO_LEDGER_IMPORT_ENABLED !== 'true') {
    return Response.json({ error: 'LEDGER_IMPORT_DISABLED', message: 'Enable ledger imports in the server environment before committing.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const result = await importVerifiedLedger(getDatabasePool(), csv, { filename });
    if (result.status === 'rejected') return Response.json({ error: 'LEDGER_HAS_REJECTED_ROWS', ...result }, { status: 422, headers: { 'Cache-Control': 'no-store' } });
    return Response.json({ action: 'imported', ...result }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: 'LEDGER_IMPORT_UNAVAILABLE' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
