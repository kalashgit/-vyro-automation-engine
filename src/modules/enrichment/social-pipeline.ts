import type { Pool } from 'pg';
import { withTransaction } from '../database/client.ts';
import { JobExecutionError } from '../workers/worker.ts';
import type { JobHandler } from '../workers/worker.ts';
import { collectOfficialPages, officialUrl } from './official-site-fetcher.ts';
import type { PageCollector } from './official-site-fetcher.ts';
import { profilesFromRecord, profilesFromPage, isSocialHost } from './public-profiles.mjs';

type Observation={url:string;platform:string;handle:string;source:string;relationship:'supplied_profile'|'website_link';details:string;observedAt:Date};
/** Preserve account routes without inferring ownership, deliverability, or permission to send. */
export function createSocialEnrichmentHandler(pool:Pool,collector:PageCollector=collectOfficialPages,collectWebsites=false):JobHandler {
 return async(job,{signal})=>{
  const recordId=job.payload.recordId;
  if(typeof recordId!=='string'||!/^[A-Z0-9]+-[A-Z0-9-]{1,199}$/.test(recordId)) throw new JobExecutionError('INVALID_RECORD_ID',{retryable:false});
  signal.throwIfAborted();
  if((await pool.query('SELECT 1 FROM social_enrichment_runs WHERE job_id=$1',[job.id])).rowCount) return;
  if((await pool.query(`SELECT 1 FROM import_rows r WHERE NOT EXISTS(SELECT 1 FROM profile_indexed_rows i WHERE i.import_row_id=r.import_row_id) LIMIT 1`)).rowCount)
    throw new JobExecutionError('PROFILE_INDEX_INCOMPLETE',{retryable:false});
  const {rows:[p]}=await pool.query(`SELECT p.*,r.raw_payload,r.created_at AS imported_at FROM prospects p
    LEFT JOIN LATERAL (SELECT raw_payload,created_at FROM import_rows WHERE batch_id=p.source_batch_id AND raw_record_id=p.record_id ORDER BY row_number LIMIT 1) r ON true
    WHERE p.record_id=$1`,[recordId]);
  if(!p)throw new JobExecutionError('UNKNOWN_RECORD_ID',{retryable:false});
  if(p.identity_status!=='certified'||p.suppression_status==='suppressed'||p.relevance_status==='irrelevant') throw new JobExecutionError('PROSPECT_CHANGED_OR_BLOCKED',{retryable:false});
  const observations:Observation[]=profilesFromRecord(p.raw_payload??{}).map(profile=>({...profile,source:profile.url,
    relationship:'supplied_profile',details:'Imported field: '+profile.field,observedAt:p.imported_at}));
  const notes:string[]=[];
  if(collectWebsites&&p.canonical_domain&&!isSocialHost(p.canonical_domain)) {
    try {
      const pages=await collector(p.canonical_domain,signal);
      if(pages.length>3)throw new JobExecutionError('INVALID_COLLECTOR_RESULT',{retryable:false});
      for(const page of pages) {
        const source=officialUrl(page.url,p.canonical_domain).href;
        if(typeof page.text!=='string'||Buffer.byteLength(page.text)>1_000_000||!(page.fetchedAt instanceof Date)||
          !Number.isFinite(page.fetchedAt.getTime())||page.fetchedAt.getTime()>Date.now()+1000||page.fetchedAt.getTime()<Date.now()-300_000)
          throw new JobExecutionError('INVALID_COLLECTOR_RESULT',{retryable:false});
        for(const profile of profilesFromPage(page.text)) observations.push({...profile,source,relationship:'website_link',
          details:'Account link observed on recorded website; ownership requires review.',observedAt:page.fetchedAt});
      }
    } catch(error) {
      signal.throwIfAborted();
      if(!(error instanceof JobExecutionError)||error.retryable)throw error;
      notes.push(error.code);
    }
  } else notes.push(collectWebsites?'OFFICIAL_DOMAIN_MISSING':'WEBSITE_COLLECTION_DISABLED');
  if(!observations.length) notes.push('MANUAL_PROFILE_RESEARCH_REQUIRED');
  signal.throwIfAborted();
  await withTransaction(pool,async client=>{
    const {rows:[lease]}=await client.query(`SELECT 1 FROM jobs WHERE job_id=$1 AND status='leased' AND leased_by=$2
      AND lease_token=$3 AND lease_expires_at>clock_timestamp() FOR UPDATE`,[job.id,job.leasedBy,job.leaseToken]);
    if(!lease)throw new JobExecutionError('ENRICHMENT_LEASE_LOST');
    if((await client.query('SELECT 1 FROM social_enrichment_runs WHERE job_id=$1',[job.id])).rowCount)return;
    const {rows:[current]}=await client.query('SELECT * FROM prospects WHERE record_id=$1 FOR UPDATE',[recordId]);
    if(!current||current.identity_status!=='certified'||current.suppression_status==='suppressed'||current.relevance_status==='irrelevant'||
      current.canonical_domain!==p.canonical_domain||current.canonical_profile_url!==p.canonical_profile_url||
      (await client.query("SELECT 1 FROM identity_conflicts WHERE existing_record_id=$1 AND review_status='pending'",[recordId])).rowCount)
      throw new JobExecutionError('PROSPECT_CHANGED_OR_BLOCKED',{retryable:false});
    const {rows:[run]}=await client.query(`INSERT INTO social_enrichment_runs(job_id,record_id,outcome,notes) VALUES($1,$2,$3,$4) RETURNING run_id`,
      [job.id,recordId,observations.length?'profiles_found':'needs_review',notes]);
    for(const url of [...new Set(observations.map(o=>o.url))].sort()) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 2))',[url]);
    for(const o of observations) {
      const {rows:duplicates}=await client.query(`SELECT record_id FROM prospects WHERE canonical_profile_url=$1 AND record_id<>$2
        UNION SELECT COALESCE(record_id,'import-row:'||import_row_id::text) FROM import_profile_routes WHERE canonical_url=$1 AND record_id IS DISTINCT FROM $2
        UNION SELECT record_id FROM social_profile_evidence WHERE canonical_url=$1 AND record_id<>$2 ORDER BY record_id`,[o.url,recordId]);
      await client.query(`INSERT INTO social_profile_evidence(run_id,record_id,canonical_url,platform,handle,source_url,relationship,source_details,duplicate_record_ids,observed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
        [run.run_id,recordId,o.url,o.platform,o.handle,o.source,o.relationship,o.details,duplicates.map(d=>d.record_id),o.observedAt]);
    }
    signal.throwIfAborted();
    if(!(await client.query('SELECT 1 FROM jobs WHERE job_id=$1 AND lease_expires_at>clock_timestamp()',[job.id])).rowCount)throw new JobExecutionError('ENRICHMENT_LEASE_LOST');
  });
 };
}
