import { getDatabasePool } from '@/modules/database/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Report only coarse failure categories, never raw database errors or credentials.
export async function GET() {
  if (!process.env.DATABASE_URL?.trim()) {
    console.warn('VYRO_DB_HEALTH: missing_database_url');
    return Response.json({ status: 'unavailable', check: 'configuration' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  let pool;
  try {
    pool = getDatabasePool();
  } catch {
    console.warn('VYRO_DB_HEALTH: invalid_database_configuration');
    return Response.json({ status: 'unavailable', check: 'configuration' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const result = await pool.query("SELECT to_regclass('public.email_suppressions') IS NOT NULL AS ready");
    if (result.rows[0]?.ready === true) {
      return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
    }
    console.warn('VYRO_DB_HEALTH: suppression_table_missing');
    return Response.json({ status: 'unavailable', check: 'schema' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    console.warn('VYRO_DB_HEALTH: connection_or_query_failed');
    return Response.json({ status: 'unavailable', check: 'connection' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
