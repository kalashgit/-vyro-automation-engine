import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {before,after,describe,test} from 'node:test';
import {applyMigrations} from '../src/modules/database/migrate.ts';
import {createQueue} from '../src/modules/queue/queue.ts';
import {createSocialEnrichmentHandler} from '../src/modules/enrichment/social-pipeline.ts';
import {createAcquisitionHandlers} from '../src/modules/workers/acquisition-handlers.ts';
import {backfillProfileIndex,recoverDeferredProfiles} from '../src/modules/enrichment/profile-index.ts';
import {getEnrichmentResults} from '../src/modules/enrichment/results.ts';
import {createDatabaseFixture} from './helpers/database.ts';
import type {DatabaseFixture} from './helpers/database.ts';

describe('Social account enrichment to PostgreSQL',{concurrency:false},()=>{
 let f:DatabaseFixture;
 before(async()=>{f=await createDatabaseFixture();await applyMigrations(f.pool);});
 after(async()=>{if(f)await f.dispose();});
 const signal=()=>new AbortController().signal;
 async function rawRow(url:string,createProspect=true) {
  const key=randomUUID().replaceAll('-',''),recordId='CRE-'+key.toUpperCase();
  const {rows:[b]}=await f.pool.query(`INSERT INTO import_batches(source_worker,source_batch,original_source_evidence,raw_discovered_count) VALUES('CRE',$1,'{}',1) RETURNING batch_id`,[key]);
  await f.pool.query(`INSERT INTO import_rows(batch_id,row_number,raw_record_id,raw_payload) VALUES($1,1,$2,$3)`,[b.batch_id,recordId,{Entity:'Creator '+key,'Website/Profile':url,'Source URL':url}]);
  if(createProspect)await f.pool.query(`INSERT INTO prospects(record_id,source_batch_id,source_worker,original_source_evidence,normalized_company_name,country,identity_status,identity_certified_at) VALUES($1,$2,'CRE','{}',$3,'GR','certified',now())`,[recordId,b.batch_id,'creator '+key]);
  return {recordId,batchId:b.batch_id};
 }
 async function seed(url='https://twitch.tv/creator_'+randomUUID().replaceAll('-','')) {
  const r=await rawRow(url);await backfillProfileIndex(f.pool);
  const q=createQueue(f.pool),queued=await q.enqueue({type:'enrich_contact',payload:{recordId:r.recordId,mode:'social_profiles'},idempotencyKey:randomUUID()});
  const job=await q.claim('social-test',{types:['enrich_contact'],leaseDurationMs:60_000});
  assert.ok(job);assert.equal(job.id,queued.job.id);
  return {...r,q,job};
 }
 async function finish(s:Awaited<ReturnType<typeof seed>>) {await s.q.complete({jobId:s.job.id,workerId:s.job.leasedBy,leaseToken:s.job.leaseToken});}
 test('stores profile routes with provenance, replays once, and never creates approval or outreach',async()=>{
  const s=await seed();const handlers=createAcquisitionHandlers(f.pool,{socialEnabled:true});
  await handlers.enrich_contact!(s.job,{signal:signal()});await handlers.enrich_contact!(s.job,{signal:signal()});
  const {rows}=await f.pool.query('SELECT * FROM social_profile_evidence WHERE record_id=$1',[s.recordId]);
  assert.equal(rows.length,1);assert.equal(rows[0].relationship,'supplied_profile');assert.equal(rows[0].review_status,'pending');
  assert.equal(rows[0].dm_availability,'unknown');assert.equal(rows[0].account_availability,'unknown');
  for(const table of ['contact_points','recipient_verification_evidence','outreach_preparations'])assert.equal((await f.pool.query(`SELECT 1 FROM ${table} WHERE record_id=$1`,[s.recordId])).rowCount,0);
  assert.equal((await getEnrichmentResults(f.pool)).counts.with_profiles,1);
  await assert.rejects(f.pool.query('UPDATE social_profile_evidence SET handle=handle WHERE record_id=$1',[s.recordId]));
  await finish(s);
 });
 test('duplicate detection covers accounts in raw rows never enriched or promoted',async()=>{
  const url='https://instagram.com/shared_'+randomUUID().replaceAll('-','');
  const original=await rawRow(url+'/?tracking=one',false);const s=await seed(url.toUpperCase());
  await createSocialEnrichmentHandler(f.pool)(s.job,{signal:signal()});
  const {rows:[e]}=await f.pool.query('SELECT duplicate_record_ids FROM social_profile_evidence WHERE record_id=$1',[s.recordId]);
  assert.deepEqual(e.duplicate_record_ids,[original.recordId]);await finish(s);
 });
 test('website account links retain the exact website source, supplied links survive no website',async()=>{
  const s=await seed();await f.pool.query('UPDATE prospects SET canonical_domain=$2 WHERE record_id=$1',[s.recordId,'creator.example']);
  await createSocialEnrichmentHandler(f.pool,async()=>[{url:'https://creator.example/contact',text:'<a href="https://youtube.com/@example">My channel</a>',fetchedAt:new Date()}],true)(s.job,{signal:signal()});
  const {rows:[e]}=await f.pool.query("SELECT * FROM social_profile_evidence WHERE record_id=$1 AND relationship='website_link'",[s.recordId]);
  assert.equal(e.source_url,'https://creator.example/contact');assert.equal(e.canonical_url,'https://youtube.com/@example');await finish(s);
 });
 test('no account evidence is a research-needed outcome, never invented from the name',async()=>{
  const s=await seed('https://example.org/post');await createSocialEnrichmentHandler(f.pool)(s.job,{signal:signal()});
  const {rows:[r]}=await f.pool.query('SELECT * FROM social_enrichment_runs WHERE job_id=$1',[s.job.id]);
  assert.equal(r.outcome,'needs_review');assert.ok(r.notes.includes('MANUAL_PROFILE_RESEARCH_REQUIRED'));await finish(s);
 });
 test('incomplete account index and cancellation prevent partial results',async()=>{
  const s=await seed();await rawRow('https://twitch.tv/unindexed',false);
  await assert.rejects(createSocialEnrichmentHandler(f.pool)(s.job,{signal:signal()}),e=>(e as {code:string}).code==='PROFILE_INDEX_INCOMPLETE');
  await backfillProfileIndex(f.pool);const c=new AbortController();c.abort();
  await assert.rejects(createSocialEnrichmentHandler(f.pool)(s.job,{signal:c.signal}));
  assert.equal((await f.pool.query('SELECT 1 FROM social_enrichment_runs WHERE job_id=$1',[s.job.id])).rowCount,0);await finish(s);
 });
 test('revoked leases fence writes',async()=>{
  const s=await seed();await finish(s);
  await assert.rejects(createSocialEnrichmentHandler(f.pool)(s.job,{signal:signal()}),e=>(e as {code:string}).code==='ENRICHMENT_LEASE_LOST');
  assert.equal((await f.pool.query('SELECT 1 FROM social_enrichment_runs WHERE job_id=$1',[s.job.id])).rowCount,0);
 });
 test('evidence insert failure rolls back the entire run',async()=>{
  const s=await seed();
  await f.pool.query(`CREATE FUNCTION reject_social_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END; $$;
    CREATE TRIGGER reject_social_fixture BEFORE INSERT ON social_profile_evidence FOR EACH ROW EXECUTE FUNCTION reject_social_fixture()`);
  try{await assert.rejects(createSocialEnrichmentHandler(f.pool)(s.job,{signal:signal()}));}
  finally{await f.pool.query('DROP TRIGGER reject_social_fixture ON social_profile_evidence; DROP FUNCTION reject_social_fixture()');}
  assert.equal((await f.pool.query('SELECT 1 FROM social_enrichment_runs WHERE job_id=$1',[s.job.id])).rowCount,0);await finish(s);
 });
 test('recovers deferred countryless account rows without rewriting the original audit',async()=>{
  const r=await rawRow('https://twitch.tv/recovered_'+randomUUID().replaceAll('-',''),false);
  await backfillProfileIndex(f.pool);const result=await recoverDeferredProfiles(f.pool);assert.ok(result.recovered>=1);
  const {rows:[p]}=await f.pool.query('SELECT * FROM prospects WHERE record_id=$1',[r.recordId]);
  assert.equal(p.identity_status,'unchecked');assert.equal(p.country,null);assert.ok(p.canonical_profile_url.startsWith('https://twitch.tv/'));
  assert.equal((await recoverDeferredProfiles(f.pool)).recovered,0);
 });
 test('4,000 synthetic profile-only prospects can be indexed, previewed, and enqueued idempotently',{timeout:120000},async()=>{
  const {rows:[b]}=await f.pool.query(`INSERT INTO import_batches(source_worker,source_batch,original_source_evidence,raw_discovered_count) VALUES('B2C','scale-fixture','{}',4000) RETURNING batch_id`);
  await f.pool.query(`INSERT INTO import_rows(batch_id,row_number,raw_record_id,raw_payload)
    SELECT $1,n,'B2C-SCALE-'||n,jsonb_build_object('Website/Profile','https://twitch.tv/scale_'||n) FROM generate_series(1,4000)n`,[b.batch_id]);
  await f.pool.query(`INSERT INTO prospects(record_id,source_batch_id,source_worker,original_source_evidence,canonical_profile_url,category,identity_status,identity_certified_at)
    SELECT 'B2C-SCALE-'||n,$1,'B2C','{}','https://twitch.tv/scale_'||n,'B2C','certified',now() FROM generate_series(1,4000)n`,[b.batch_id]);
  assert.equal((await backfillProfileIndex(f.pool)).indexed,4000);
  const run=async(apply:boolean)=>{
   const {stdout}=await promisify(execFile)(process.execPath,['--experimental-strip-types','scripts/enrich-contacts.mjs','--mode','social_profiles','--category','B2C','--limit','4000','--campaign','scale-fixture',...(apply?['--apply']:[])],{
    env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,DATABASE_SSL_MODE:'disable',PGOPTIONS:'-c search_path='+f.schema},timeout:100000});return JSON.parse(stdout);
  };
  const preview=await run(false);assert.equal(preview.selected,4000);assert.equal(preview.created,0);
  const applied=await run(true);assert.equal(applied.created,4000);
  const again=await run(true);assert.equal(again.created,0);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM jobs WHERE payload->>'mode'='social_profiles' AND status='queued'")).rows[0].n,4000);
 });
});
