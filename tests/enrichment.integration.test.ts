import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { before,after,describe,test } from 'node:test';
import { applyMigrations } from '../src/modules/database/migrate.ts';
import { createQueue } from '../src/modules/queue/queue.ts';
import { createAcquisitionHandlers } from '../src/modules/workers/acquisition-handlers.ts';
import { createEnrichmentHandler } from '../src/modules/enrichment/pipeline.ts';
import { JobExecutionError, runWorker } from '../src/modules/workers/worker.ts';
import { createDatabaseFixture } from './helpers/database.ts';
import type { DatabaseFixture } from './helpers/database.ts';
import type { FetchedPage } from '../src/modules/enrichment/official-site-fetcher.ts';

describe('Official site enrichment to PostgreSQL', {concurrency:false},()=>{
  let fixture:DatabaseFixture;
  before(async()=>{ fixture=await createDatabaseFixture(); await applyMigrations(fixture.pool); });
  after(async()=>{ if(fixture) await fixture.dispose(); });
  async function seed() {
    const key=randomUUID().replaceAll('-','');
    const recordId='B2B-'+key.toUpperCase();
    const domain='shop'+key+'.gr';
    const {rows:[batch]}=await fixture.pool.query(`INSERT INTO import_batches(source_worker,source_batch,original_source_evidence,raw_discovered_count)
      VALUES('B2B',$1,'{}',1) RETURNING batch_id`,[key]);
    await fixture.pool.query(`INSERT INTO import_rows(batch_id,row_number,raw_record_id,raw_payload) VALUES($1,1,$2,$3)`,
      [batch.batch_id,recordId,{Entity:'Fixture Shop',Phone:'2101234567',Location:'Athens','Source URL':'https://'+domain}]);
    await fixture.pool.query(`INSERT INTO prospects(record_id,source_batch_id,source_worker,original_source_evidence,canonical_domain,
      identity_status,identity_certified_at) VALUES($1,$2,'B2B','{}',$3,'certified',now())`,[recordId,batch.batch_id,domain]);
    const q=createQueue(fixture.pool);
    const queued=await q.enqueue({type:'enrich_contact',payload:{recordId,mode:'official_site'},idempotencyKey:randomUUID()});
    const job=await q.claim('enrichment-test',{types:['enrich_contact'],leaseDurationMs:60_000});
    assert.ok(job); assert.equal(job.id,queued.job.id);
    const page:FetchedPage={url:'https://'+domain+'/contact',text:`<h1>Fixture Shop</h1><p>Athens +30 2101234567 info@${domain}</p>`,fetchedAt:new Date()};
    return {recordId,domain,job,page,q};
  }
  const signal=()=>new AbortController().signal;
  async function finish(s:Awaited<ReturnType<typeof seed>>) {
    await s.q.complete({jobId:s.job.id,workerId:s.job.leasedBy,leaseToken:s.job.leaseToken});
  }
  test('collects, atomically stores evidence, reads back exact ID, and replays without another fetch',async()=>{
    const s=await seed(); let calls=0;
    const handler=createEnrichmentHandler(fixture.pool,async()=>{ calls++; return [s.page]; });
    await handler(s.job,{signal:signal()}); await handler(s.job,{signal:signal()});
    assert.equal(calls,1);
    const {rows:[e]}=await fixture.pool.query(`SELECT c.*,p.source_url,p.content_sha256,p.fetched_at
      FROM enrichment_candidates c JOIN enrichment_pages p USING(page_id) WHERE c.record_id=$1`,[s.recordId]);
    assert.equal(e.email_normalized,'info@'+s.domain); assert.equal(e.identity_decision,'substantiated');
    assert.equal(e.source_url,s.page.url); assert.match(e.content_sha256,/^[a-f0-9]{64}$/);
    assert.equal(e.fetched_at.getTime(),s.page.fetchedAt.getTime());
    assert.equal(e.delivery_verified,false); assert.equal(e.review_status,'pending');
    const {rows:[contact]}=await fixture.pool.query('SELECT * FROM contact_points WHERE record_id=$1',[s.recordId]);
    assert.equal(contact.verification_status,'unverified'); assert.equal(contact.verified_at,null);
    const {rows:[prospect]}=await fixture.pool.query('SELECT * FROM prospects WHERE record_id=$1',[s.recordId]);
    assert.equal(prospect.verification_status,'unverified'); assert.equal(prospect.suppression_status,'unchecked');
    assert.equal((await fixture.pool.query('SELECT 1 FROM recipient_verification_evidence WHERE record_id=$1',[s.recordId])).rowCount,0);
    assert.equal((await fixture.pool.query('SELECT 1 FROM outreach_preparations WHERE record_id=$1',[s.recordId])).rowCount,0);
    await finish(s);
  });
  test('unmatched identity stays review-only, while empty pages produce an honest no-candidates outcome',async()=>{
    const s=await seed(); s.page.text='Other Company info@'+s.domain;
    await createEnrichmentHandler(fixture.pool,async()=>[s.page])(s.job,{signal:signal()});
    assert.equal((await fixture.pool.query('SELECT identity_decision FROM enrichment_candidates WHERE record_id=$1',[s.recordId])).rows[0].identity_decision,'unresolved');
    assert.equal((await fixture.pool.query('SELECT 1 FROM contact_points WHERE record_id=$1',[s.recordId])).rowCount,0);
    await finish(s);
    const empty=await seed(); empty.page.text='Fixture Shop Athens';
    await createEnrichmentHandler(fixture.pool,async()=>[empty.page])(empty.job,{signal:signal()});
    assert.equal((await fixture.pool.query('SELECT outcome FROM enrichment_runs WHERE record_id=$1',[empty.recordId])).rows[0].outcome,'no_candidates');
    await finish(empty);
  });
  test('case-insensitive global duplicates and suppressed emails are recorded but not added to contact staging',async()=>{
    const existing=await seed(); await finish(existing);
    const s=await seed();
    await fixture.pool.query("INSERT INTO contact_points(record_id,channel,value,source_url) VALUES($1,'email',$2,$3)",
      [existing.recordId,('info@'+s.domain).toUpperCase(),existing.page.url]);
    s.page.text+=` blocked@${s.domain}`;
    await fixture.pool.query('INSERT INTO email_suppressions(email_normalized) VALUES($1)',['blocked@'+s.domain]);
    await createEnrichmentHandler(fixture.pool,async()=>[s.page])(s.job,{signal:signal()});
    const {rows}=await fixture.pool.query('SELECT * FROM enrichment_candidates WHERE record_id=$1 ORDER BY email_normalized',[s.recordId]);
    assert.equal(rows.length,2); assert.equal(rows[0].suppressed,true);
    assert.deepEqual(rows[1].duplicate_record_ids,[existing.recordId]);
    assert.equal((await fixture.pool.query('SELECT 1 FROM contact_points WHERE record_id=$1',[s.recordId])).rowCount,0);
    await finish(s);
  });
  test('simultaneous records sharing an email cannot both stage it',async()=>{
    const a=await seed(),b=await seed();
    const email='shared-'+randomUUID()+'@business.gr';
    a.page.text='Fixture Shop Athens '+email; b.page.text=a.page.text;
    await Promise.all([
      createEnrichmentHandler(fixture.pool,async()=>[a.page])(a.job,{signal:signal()}),
      createEnrichmentHandler(fixture.pool,async()=>[b.page])(b.job,{signal:signal()}),
    ]);
    assert.equal((await fixture.pool.query("SELECT 1 FROM contact_points WHERE channel='email' AND value=$1",[email])).rowCount,1);
    assert.equal((await fixture.pool.query('SELECT 1 FROM enrichment_candidates WHERE email_normalized=$1 AND cardinality(duplicate_record_ids)>0',[email])).rowCount,1);
    await finish(a);await finish(b);
  });
  test('dedupe includes original ledger emails that have never reached contact staging',async()=>{
    const s=await seed();
    const other='B2B-UNSTAGED-'+randomUUID().replaceAll('-','').toUpperCase();
    const {rows:[batch]}=await fixture.pool.query(`INSERT INTO import_batches(source_worker,source_batch,original_source_evidence,raw_discovered_count)
      VALUES('B2B',$1,'{}',1) RETURNING batch_id`,[other]);
    await fixture.pool.query(`INSERT INTO import_rows(batch_id,row_number,raw_record_id,raw_payload) VALUES($1,1,$2,$3)`,
      [batch.batch_id,other,{Email:`Sales <INFO@${s.domain.toUpperCase()}>; other@business.gr`}]);
    await createEnrichmentHandler(fixture.pool,async()=>[s.page])(s.job,{signal:signal()});
    assert.deepEqual((await fixture.pool.query('SELECT duplicate_record_ids FROM enrichment_candidates WHERE record_id=$1',[s.recordId])).rows[0].duplicate_record_ids,[other]);
    assert.equal((await fixture.pool.query('SELECT 1 FROM contact_points WHERE record_id=$1',[s.recordId])).rowCount,0);
    await finish(s);
  });
  test('expired or replaced leases cannot commit results',async()=>{
    const s=await seed();
    await fixture.pool.query("UPDATE jobs SET lease_token=gen_random_uuid() WHERE job_id=$1",[s.job.id]);
    await assert.rejects(createEnrichmentHandler(fixture.pool,async()=>[s.page])(s.job,{signal:signal()}),e=>e instanceof JobExecutionError&&e.code==='ENRICHMENT_LEASE_LOST');
    assert.equal((await fixture.pool.query('SELECT 1 FROM enrichment_runs WHERE record_id=$1',[s.recordId])).rowCount,0);
    await fixture.pool.query('UPDATE jobs SET lease_token=$2 WHERE job_id=$1',[s.job.id,s.job.leaseToken]);
    await finish(s);
  });
  test('cancellation and transient retrieval failure leave no partial evidence; retry succeeds',async()=>{
    const s=await seed(); const controller=new AbortController();
    await assert.rejects(createEnrichmentHandler(fixture.pool,async()=>{controller.abort();return [s.page];})(s.job,{signal:controller.signal}));
    await assert.rejects(createEnrichmentHandler(fixture.pool,async()=>{throw new JobExecutionError('SOURCE_TIMEOUT');})(s.job,{signal:signal()}));
    assert.equal((await fixture.pool.query('SELECT 1 FROM enrichment_runs WHERE record_id=$1',[s.recordId])).rowCount,0);
    await createEnrichmentHandler(fixture.pool,async()=>[s.page])(s.job,{signal:signal()});
    await finish(s);
  });
  test('database failure rolls back run, page, candidate and contact together',async()=>{
    const s=await seed();
    await fixture.pool.query(`CREATE FUNCTION reject_enrichment_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture rejection'; END; $$;
      CREATE TRIGGER reject_enrichment_fixture BEFORE INSERT ON contact_points FOR EACH ROW EXECUTE FUNCTION reject_enrichment_fixture();`);
    try {
      await assert.rejects(createEnrichmentHandler(fixture.pool,async()=>[s.page])(s.job,{signal:signal()}),/fixture rejection/);
      assert.equal((await fixture.pool.query('SELECT 1 FROM enrichment_runs WHERE record_id=$1',[s.recordId])).rowCount,0);
      assert.equal((await fixture.pool.query('SELECT 1 FROM enrichment_candidates WHERE record_id=$1',[s.recordId])).rowCount,0);
    } finally { await fixture.pool.query('DROP TRIGGER reject_enrichment_fixture ON contact_points; DROP FUNCTION reject_enrichment_fixture()'); }
    await createEnrichmentHandler(fixture.pool,async()=>[s.page])(s.job,{signal:signal()});
    await finish(s);
  });
  test('permanent retrieval blocks produce a durable review reason; disabled handler never fetches',async()=>{
    const s=await seed(); let fetched=false;
    const disabled=createAcquisitionHandlers(fixture.pool,{collector:async()=>{fetched=true;return [s.page];}}).enrich_contact!;
    await assert.rejects(disabled(s.job,{signal:signal()}),e=>e instanceof JobExecutionError&&e.code==='ENRICHMENT_DISABLED');
    assert.equal(fetched,false);
    await createEnrichmentHandler(fixture.pool,async()=>{throw new JobExecutionError('ROBOTS_DISALLOWED',{retryable:false});})(s.job,{signal:signal()});
    assert.deepEqual((await fixture.pool.query('SELECT outcome,reason FROM enrichment_runs WHERE record_id=$1',[s.recordId])).rows[0],
      {outcome:'needs_review',reason:'ROBOTS_DISALLOWED'});
    await finish(s);
  });
  test('CLI preview and idempotent apply feed a real worker through database completion',async()=>{
    const s=await seed(); await finish(s);
    const args=['--experimental-strip-types',fileURLToPath(new URL('../scripts/enrich-contacts.mjs',import.meta.url)),
      '--campaign',randomUUID(),'--record-id',s.recordId];
    const options={env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,DATABASE_SSL_MODE:'disable',PGOPTIONS:'-c search_path='+fixture.schema},timeout:10_000};
    const preview=JSON.parse((await promisify(execFile)(process.execPath,args,options)).stdout);
    assert.equal(preview.mode,'preview');assert.equal(preview.created,0);assert.equal(preview.selected,1);
    assert.equal((await fixture.pool.query("SELECT 1 FROM jobs WHERE payload->>'recordId'=$1 AND status='queued'",[s.recordId])).rowCount,0);
    const first=JSON.parse((await promisify(execFile)(process.execPath,[...args,'--apply'],options)).stdout);
    const replay=JSON.parse((await promisify(execFile)(process.execPath,[...args,'--apply'],options)).stdout);
    assert.equal(first.created,1);assert.equal(replay.created,0);assert.equal(replay.replayed,1);
    const {rows:[queued]}=await fixture.pool.query("SELECT job_id AS id FROM jobs WHERE payload->>'recordId'=$1 AND status='queued'",[s.recordId]);
    const controller=new AbortController();
    const running=runWorker(fixture.pool,{handlers:createAcquisitionHandlers(fixture.pool,{officialSiteEnabled:true,collector:async()=>[s.page]}),
      signal:controller.signal,pollIntervalMs:10,heartbeatIntervalMs:100,leaseDurationMs:1000});
    try {
      const deadline=Date.now()+5000;let state;
      while(Date.now()<deadline) {
        state=(await fixture.pool.query('SELECT status FROM jobs WHERE job_id=$1',[queued.id])).rows[0].status;
        if(state==='succeeded'||state==='dead') break;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      assert.equal(state,'succeeded');
      assert.equal((await fixture.pool.query('SELECT 1 FROM enrichment_runs WHERE job_id=$1',[queued.id])).rowCount,1);
    } finally { controller.abort();await running; }
  });
});
