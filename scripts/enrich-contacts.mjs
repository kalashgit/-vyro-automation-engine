import { getDatabasePool } from '../src/modules/database/client.ts';
import { createQueue } from '../src/modules/queue/queue.ts';

// Operator-selected batch; preview is the default. No mail or approval operations.
const args=process.argv.slice(2);
const allowed=new Set(['--apply','--limit','--campaign','--record-id']);
let apply=false,limit=25,campaign,recordId;
for(let i=0;i<args.length;i++) {
  const flag=args[i];
  if(!allowed.has(flag)) throw new Error('Unknown argument: '+flag);
  if(flag==='--apply') { apply=true; continue; }
  const value=args[++i];
  if(!value || value.startsWith('--')) throw new Error('Missing value for '+flag);
  if(flag==='--limit') limit=Number(value);
  if(flag==='--campaign') campaign=value;
  if(flag==='--record-id') recordId=value;
}
if(!Number.isSafeInteger(limit)||limit<1||limit>100) throw new Error('Limit must be 1–100.');
if(!campaign || !/^[a-zA-Z0-9_-]{1,40}$/.test(campaign)) throw new Error('Provide --campaign with a stable batch label (1–40 letters, digits, _ or -).');
if(recordId && !/^[A-Z0-9]+-[A-Z0-9-]{1,199}$/.test(recordId)) throw new Error('Invalid record ID.');
const pool=getDatabasePool();
try {
  const {rows}=await pool.query(`SELECT p.record_id FROM prospects p
    WHERE p.identity_status='certified' AND p.relevance_status<>'irrelevant'
      AND p.suppression_status<>'suppressed' AND ($1::text IS NULL OR p.record_id=$1)
      AND NOT EXISTS (SELECT 1 FROM identity_conflicts c WHERE c.existing_record_id=p.record_id AND c.review_status='pending')
      AND ($1::text IS NOT NULL OR (
        p.canonical_domain IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM contact_points c WHERE c.record_id=p.record_id AND c.channel='email')
        AND NOT EXISTS(SELECT 1 FROM import_rows r WHERE r.batch_id=p.source_batch_id AND r.raw_record_id=p.record_id
          AND COALESCE(r.raw_payload->>'Email','') ~* '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,24}')
        AND NOT EXISTS(SELECT 1 FROM enrichment_runs r WHERE r.record_id=p.record_id AND r.completed_at>clock_timestamp()-interval '7 days')
        AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.type='enrich_contact' AND j.payload->>'recordId'=p.record_id AND j.status IN ('queued','leased','retry'))
      ))
    ORDER BY CASE WHEN p.category='B2B' THEN 0 ELSE 1 END,
      CASE WHEN EXISTS (SELECT 1 FROM import_rows r WHERE r.batch_id=p.source_batch_id AND r.raw_record_id=p.record_id
        AND nullif(btrim(r.raw_payload->>'Phone'),'') IS NOT NULL) THEN 0 ELSE 1 END,
      p.created_at,p.record_id LIMIT $2`,[recordId??null,limit]);
  let created=0,replayed=0;
  if(apply) {
    const {createHash}=await import('node:crypto');
    const queue=createQueue(pool);
    for(const row of rows) {
      const key=createHash('sha256').update(row.record_id).digest('hex');
      const result=await queue.enqueue({type:'enrich_contact',payload:{recordId:row.record_id,mode:'official_site'},
        idempotencyKey:`enrichment:v1:${campaign}:${key}`,retryBackoffMs:30_000,retryMaxBackoffMs:300_000,maxAttempts:4});
      if(result.created) created++; else replayed++;
    }
  }
  console.log(JSON.stringify({mode:apply?'enqueued':'preview',selected:rows.length,created,replayed,campaign}));
} finally { await pool.end(); }
