import { requireAdmin } from '@/lib/admin-auth';
import { getDatabasePool } from '@/modules/database/client';
import { getEnrichmentResults } from '@/modules/enrichment/results';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request) {
 const denied=requireAdmin(request);if(denied)return denied;
 const raw=new URL(request.url).searchParams.get('offset')??'0';
 if(!/^\d{1,7}$/.test(raw))return Response.json({error:'INVALID_OFFSET'},{status:400});
 try{return Response.json(await getEnrichmentResults(getDatabasePool(),Number(raw)),{headers:{'Cache-Control':'no-store'}});}
 catch{return Response.json({error:'ENRICHMENT_DATABASE_UNAVAILABLE'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
