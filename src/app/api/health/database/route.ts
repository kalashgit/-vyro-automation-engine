import { getDatabasePool } from '@/modules/database/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Never reveal connection details or raw database errors to public callers.
export async function GET() {
  try {
    const pool = getDatabasePool();
    const result = await pool.query("SELECT to_regclass('public.email_suppressions') IS NOT NULL AS ready");
    if (result.rows[0]?.ready === true) {
      return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
    }
  } catch {
    // Intentionally return only a generic status.
  }
  return Response.json({ status: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
}
