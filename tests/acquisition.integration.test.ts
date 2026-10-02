import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before,after,describe,test } from "node:test";
import { applyMigrations } from "../src/modules/database/migrate.ts";
import { createQueue } from "../src/modules/queue/queue.ts";
import { createAcquisitionHandlers } from "../src/modules/workers/acquisition-handlers.ts";
import { createDatabaseFixture } from "./helpers/database.ts";
import type { DatabaseFixture } from "./helpers/database.ts";
import type { LeasedJob,JobType } from "../src/modules/queue/types.ts";

describe("Acquisition identity and contact staging", {concurrency:false},()=>{
 let fixture:DatabaseFixture;
 const id="RES-20261002-B007-R001";
 const source="https://supplier.example/company";
 before(async()=>{
   fixture=await createDatabaseFixture();
   await applyMigrations(fixture.pool);
   const batch=await fixture.pool.query<{batch_id:string}>(
     "INSERT INTO import_batches(source_worker,source_batch,original_source_evidence,raw_discovered_count) VALUES($1,$2,$3::jsonb,1) RETURNING batch_id",
     ["RES","RES-20261002-B007",{sourceUrl:source}]);
   const batchId=batch.rows[0].batch_id;
   await fixture.pool.query("INSERT INTO import_rows(batch_id,row_number,raw_record_id,raw_payload) VALUES($1,1,$2,$3::jsonb)",
     [batchId,id,{Entity:"Fixture Shop",Email:"sales@supplier.example",Phone:"+30123456789","Source URL":source,"Website/Profile":"https://supplier.example"}]);
   await fixture.pool.query("INSERT INTO prospects(record_id,source_batch_id,source_worker,original_source_evidence,canonical_domain,normalized_company_name,country,region) VALUES($1,$2,'RES',$3::jsonb,'supplier.example','fixture shop','GR','athens')",
     [id,batchId,{sourceUrl:source}]);
 });
 after(async()=>{if(fixture)await fixture.dispose();});
 async function run(type:JobType,recordId=id){
   const q=createQueue(fixture.pool);
   await q.enqueue({type,payload:{recordId},idempotencyKey:randomUUID()});
   const lease=await q.claim("test-worker",{types:[type]});
   assert.ok(lease);
   const handler=createAcquisitionHandlers(fixture.pool)[type];
   assert.ok(handler);
   await handler(lease as LeasedJob,{signal:new AbortController().signal});
   await q.complete({jobId:lease.id,workerId:lease.leasedBy,leaseToken:lease.leaseToken});
 }
 test("cannot enrich un-reconciled identities",async()=>{
   await assert.rejects(run("enrich_contact"),/Queue job handler failed/);
   assert.equal((await fixture.pool.query("SELECT count(*)::int n FROM contact_points")).rows[0].n,0);
 });
 test("certifies database-unique identity without claiming external verification",async()=>{
   await run("reconcile_identity");
   const row=(await fixture.pool.query("SELECT identity_status,verification_status,suppression_status FROM prospects WHERE record_id=$1",[id])).rows[0];
   assert.deepEqual(row,{identity_status:"certified",verification_status:"unverified",suppression_status:"unchecked"});
 });
 test("stages original contact values with provenance and no verification, without duplicating on replay",async()=>{
   await run("enrich_contact");await run("enrich_contact");
   const {rows}=await fixture.pool.query("SELECT channel,value,source_url,verification_status FROM contact_points ORDER BY channel");
   assert.equal(rows.length,3);
   assert.deepEqual(rows.map(r=>r.channel),["email","phone","website"]);
   assert.ok(rows.every(r=>r.source_url===source && r.verification_status==="unverified"));
   assert.equal((await fixture.pool.query("SELECT verification_status FROM prospects WHERE record_id=$1",[id])).rows[0].verification_status,"unverified");
 });
 test("unknown IDs do not create records",async()=>{
   await assert.rejects(run("reconcile_identity","RES-UNKNOWN-R001"),/Queue job handler failed/);
   assert.equal((await fixture.pool.query("SELECT count(*)::int n FROM prospects")).rows[0].n,1);
 });
});