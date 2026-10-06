import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../database/client.ts';
import type { JobHandler } from '../workers/worker.ts';
import { JobExecutionError } from '../workers/worker.ts';
import { collectOfficialPages, officialUrl } from './official-site-fetcher.ts';
import type { FetchedPage, PageCollector } from './official-site-fetcher.ts';
import { extractOfficialEmails } from './public-email-extractor.ts';
import { evaluatePublicBusinessEvidence } from './business-evidence.ts';
import type { BusinessIdentity } from './business-evidence.ts';

function text(value:unknown):string|null { return typeof value==='string' && value.trim() ? value.trim() : null; }
export function visibleText(html:string):string {
  return html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ')
    .replace(/<[^>]*>/g,' ').replace(/&#(x[0-9a-f]+|\d+);/gi,(_,code:string)=>{
      const n=code[0].toLowerCase()==='x'?parseInt(code.slice(1),16):Number(code);
      return n>0 && n<=0x10ffff?String.fromCodePoint(n):' ';
    }).replace(/&(?:nbsp|amp|lt|gt|quot|apos);/g,v=>({ '&nbsp;':' ','&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'" })[v]??' ')
    .replace(/\s+/g,' ').trim();
}
function assess(page:FetchedPage,identity:BusinessIdentity) {
  const body=visibleText(page.text);
  // Only visible text and explicit mailto links; scripts/assets are not public contact evidence.
  const mailtos=[...page.text.matchAll(/href\s*=\s*["']mailto:([^"'?]+)(?:\?[^"']*)?["']/gi)]
    .map(m=>{try{return decodeURIComponent(m[1]);}catch{return '';}}).join(' ');
  return extractOfficialEmails({url:page.url,text:body+' '+mailtos},identity.officialDomain!).slice(0,50).map(candidate=>{
    const decision=evaluatePublicBusinessEvidence(identity,{
      sourceUrl:page.url,sourceHost:new URL(page.url).hostname,email:candidate.email,
      pageCompanyName:body,pageLocation:body,pagePhones:body.match(/(?:\+?30[\s.-]*)?(?:\d[\s().-]*){10}/g)??[],
    });
    const at=body.toLowerCase().indexOf(candidate.email);
    const excerpt=at>=0?body.slice(Math.max(0,at-500),at+candidate.email.length+500):'Public mailto: '+candidate.email;
    return {...candidate,decision,excerpt};
  });
}

/** At-least-once queue -> atomic evidence + staged contacts. No approval/send side effects. */
export function createEnrichmentHandler(pool:Pool, collector:PageCollector=collectOfficialPages):JobHandler {
  return async(job,{signal})=>{
    const recordId=job.payload.recordId;
    if(typeof recordId!=='string'||!/^[A-Z0-9]+-[A-Z0-9-]{1,199}$/.test(recordId))
      throw new JobExecutionError('INVALID_RECORD_ID',{retryable:false});
    signal.throwIfAborted();
    if((await pool.query('SELECT 1 FROM enrichment_runs WHERE job_id=$1',[job.id])).rowCount) return;
    const {rows:[p]}=await pool.query(`SELECT p.*, r.raw_payload FROM prospects p
      LEFT JOIN LATERAL (SELECT raw_payload FROM import_rows WHERE batch_id=p.source_batch_id
        AND raw_record_id=p.record_id ORDER BY row_number LIMIT 1) r ON true WHERE p.record_id=$1`,[recordId]);
    if(!p) throw new JobExecutionError('UNKNOWN_RECORD_ID',{retryable:false});
    if(p.identity_status!=='certified') throw new JobExecutionError('IDENTITY_NOT_READY',{retryable:false});
    if(p.suppression_status==='suppressed'||p.relevance_status==='irrelevant')
      throw new JobExecutionError('PROSPECT_CHANGED_OR_BLOCKED',{retryable:false});
    const raw=p.raw_payload??{};
    const identity:BusinessIdentity={companyName:text(raw.Entity)??p.normalized_company_name??'',
      phone:text(raw.Phone),location:text(raw.Location)??p.region,officialDomain:p.canonical_domain};
    let pages:FetchedPage[]=[]; let reason:string|null=null;
    if(!identity.officialDomain) reason='OFFICIAL_DOMAIN_MISSING';
    else {
      try { pages=await collector(identity.officialDomain,signal); }
      catch(error) {
        signal.throwIfAborted();
        if(!(error instanceof JobExecutionError) || error.retryable) throw error;
        reason=error.code;
      }
    }
    signal.throwIfAborted();
    if(pages.length>3) throw new JobExecutionError('INVALID_COLLECTOR_RESULT',{retryable:false});
    const now=Date.now();
    const sources=new Set<string>();
    for(const page of pages) {
      page.url=officialUrl(page.url,identity.officialDomain!).href;
      if(sources.has(page.url)||typeof page.text!=='string'||Buffer.byteLength(page.text)>1_000_000||
        !(page.fetchedAt instanceof Date)||!Number.isFinite(page.fetchedAt.getTime())||
        page.fetchedAt.getTime()>now+1000||page.fetchedAt.getTime()<now-300_000)
        throw new JobExecutionError('INVALID_COLLECTOR_RESULT',{retryable:false});
      sources.add(page.url);
    }
    const observations=pages.map(page=>({page,candidates:assess(page,identity)}));
    await withTransaction(pool,async client=>{
      // Fence the DB side effects against a revoked/expired lease, not just queue completion.
      const {rows:[lease]}=await client.query(`SELECT 1 FROM jobs WHERE job_id=$1 AND status='leased'
        AND leased_by=$2 AND lease_token=$3 AND lease_expires_at>clock_timestamp() FOR UPDATE`,
        [job.id,job.leasedBy,job.leaseToken]);
      if(!lease) throw new JobExecutionError('ENRICHMENT_LEASE_LOST');
      if((await client.query('SELECT 1 FROM enrichment_runs WHERE job_id=$1',[job.id])).rowCount) return;
      const {rows:[current]}=await client.query('SELECT * FROM prospects WHERE record_id=$1 FOR UPDATE',[recordId]);
      if(!current || current.identity_status!=='certified'||current.canonical_domain!==p.canonical_domain ||
          current.normalized_company_name!==p.normalized_company_name || current.region!==p.region ||
          current.suppression_status==='suppressed' || current.relevance_status==='irrelevant' ||
          (await client.query("SELECT 1 FROM identity_conflicts WHERE existing_record_id=$1 AND review_status='pending'",[recordId])).rowCount)
        throw new JobExecutionError('PROSPECT_CHANGED_OR_BLOCKED',{retryable:false});
      const count=observations.reduce((n,o)=>n+o.candidates.length,0);
      const {rows:[run]}=await client.query(`INSERT INTO enrichment_runs(job_id,record_id,outcome,reason,identity_snapshot)
        VALUES($1,$2,$3,$4,$5) RETURNING run_id`,
        [job.id,recordId,reason?'needs_review':count?'candidates_found':'no_candidates',reason,identity]);
      // Stable lock ordering protects cross-record email collision checks between enrichment workers.
      const emails=[...new Set(observations.flatMap(o=>o.candidates.map(c=>c.email)))].sort();
      for(const email of emails) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))',[email]);
      for(const {page,candidates} of observations) {
        const {rows:[saved]}=await client.query(`INSERT INTO enrichment_pages(run_id,source_url,content_sha256,fetched_at)
          VALUES($1,$2,$3,$4) RETURNING page_id`,[run.run_id,page.url,createHash('sha256').update(page.text).digest('hex'),page.fetchedAt]);
        for(const c of candidates) {
          const {rows:duplicates}=await client.query(`SELECT record_id FROM contact_points
            WHERE channel='email' AND lower(btrim(value))=$1 AND record_id<>$2
            UNION SELECT record_id FROM enrichment_candidates WHERE email_normalized=$1 AND record_id<>$2
            ORDER BY record_id`,[c.email,recordId]);
          const suppressed=Boolean((await client.query('SELECT 1 FROM email_suppressions WHERE email_normalized=$1',[c.email])).rowCount);
          await client.query(`INSERT INTO enrichment_candidates(run_id,record_id,page_id,email_normalized,
            evidence_excerpt,identity_decision,evidence_details,duplicate_record_ids,suppressed)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [run.run_id,recordId,saved.page_id,c.email,c.excerpt,c.decision.decision,c.decision,duplicates.map(d=>d.record_id),suppressed]);
          if(c.decision.decision==='substantiated'&&!duplicates.length&&!suppressed)
            await client.query(`INSERT INTO contact_points(record_id,channel,value,source_url)
              SELECT $1,'email',$2,$3 WHERE NOT EXISTS (SELECT 1 FROM contact_points
                WHERE record_id=$1 AND channel='email' AND lower(btrim(value))=$2)
              ON CONFLICT DO NOTHING`,[recordId,c.email,page.url]);
        }
      }
      signal.throwIfAborted();
      if(!(await client.query('SELECT 1 FROM jobs WHERE job_id=$1 AND lease_expires_at>clock_timestamp()',[job.id])).rowCount)
        throw new JobExecutionError('ENRICHMENT_LEASE_LOST');
    });
  };
}
