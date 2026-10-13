import type { Pool } from 'pg';
import { withTransaction } from '../database/client.ts';
import { indexImportedProfiles } from './public-profiles.mjs';
import { identityOf } from '../ingestion/import.mjs';

export async function backfillProfileIndex(pool:Pool,limit=5000) {
 if(!Number.isSafeInteger(limit)||limit<1||limit>100000)throw new Error('Invalid index limit.');
 let indexed=0;
 while(indexed<limit) {
  const n=await withTransaction(pool,async client=>{
   const {rows}=await client.query(`SELECT r.* FROM import_rows r WHERE NOT EXISTS(SELECT 1 FROM profile_indexed_rows i WHERE i.import_row_id=r.import_row_id)
     ORDER BY r.created_at,r.import_row_id LIMIT $1 FOR UPDATE OF r SKIP LOCKED`,[Math.min(500,limit-indexed)]);
   for(const r of rows)await indexImportedProfiles(client,r.import_row_id,r.raw_record_id,r.raw_payload);
   return rows.length;
  });
  indexed+=n;if(!n)break;
 }
 const {rows:[r]}=await pool.query(`SELECT count(*)::integer AS remaining FROM import_rows r WHERE NOT EXISTS(SELECT 1 FROM profile_indexed_rows i WHERE i.import_row_id=r.import_row_id)`);
 return {indexed,remaining:r.remaining};
}
/** Explicit recovery of formerly deferred account-only rows; raw audit remains untouched. */
export async function recoverDeferredProfiles(pool:Pool,limit=5000) {
 if(!Number.isSafeInteger(limit)||limit<1||limit>100000)throw new Error('Invalid recovery limit.');
 return withTransaction(pool,async client=>{
  await client.query('SELECT pg_advisory_xact_lock(19790426,102)');
  const {rows}=await client.query(`SELECT r.*,b.source_worker FROM import_rows r JOIN import_batches b USING(batch_id)
    WHERE NOT EXISTS(SELECT 1 FROM prospects p WHERE p.record_id=r.raw_record_id)
      AND NOT EXISTS(SELECT 1 FROM identity_conflicts c WHERE c.import_row_id=r.import_row_id)
      AND EXISTS(SELECT 1 FROM import_profile_routes x WHERE x.import_row_id=r.import_row_id)
    ORDER BY r.created_at,r.import_row_id LIMIT $1`,[limit]);
  let recovered=0,conflicts=0;
  for(const r of rows) {
   if(typeof r.raw_record_id!=='string'||!/^[A-Z0-9]+-[A-Z0-9-]{1,199}$/.test(r.raw_record_id))continue;
   const id=identityOf({rawPayload:r.raw_payload});
   if(!id.canonicalProfileUrl)continue;
   const result=await client.query(`INSERT INTO prospects(record_id,source_batch_id,source_worker,original_source_evidence,
     canonical_profile_url,normalized_company_name,country,region,category) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$3) ON CONFLICT DO NOTHING RETURNING record_id`,
     [r.raw_record_id,r.batch_id,r.source_worker,{recoveredImportRowId:r.import_row_id,mode:'deferred_profile_recovery'},id.canonicalProfileUrl,id.normalizedCompanyName,id.country,id.region]);
   if(result.rowCount) {
    recovered++;
    await client.query(`INSERT INTO jobs(type,payload,idempotency_key) VALUES('reconcile_identity',$1,$2) ON CONFLICT DO NOTHING`,
      [{recordId:r.raw_record_id},'profile-recovery:'+r.import_row_id]);
   }else{
    const {rows:[existing]}=await client.query('SELECT record_id FROM prospects WHERE record_id=$1 OR canonical_profile_url=$2 ORDER BY record_id LIMIT 1',[r.raw_record_id,id.canonicalProfileUrl]);
    if(!existing)throw new Error('Profile recovery conflict without existing record.');
    await client.query(`INSERT INTO identity_conflicts(import_row_id,existing_record_id,conflict_kind,evidence) VALUES($1,$2,'profile_collision',$3)`,
      [r.import_row_id,existing.record_id,{incomingRecordId:r.raw_record_id,profileUrl:id.canonicalProfileUrl}]);
    conflicts++;
   }
  }
  return {recovered,conflicts};
 });
}
