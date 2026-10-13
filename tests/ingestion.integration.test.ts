import assert from "node:assert/strict";
import { before,after,describe,test } from "node:test";
import { applyMigrations } from "../src/modules/database/migrate.ts";
import { createDatabaseFixture } from "./helpers/database.ts";
import type { DatabaseFixture } from "./helpers/database.ts";
import { identityOf,importVerifiedLedger } from "../src/modules/ingestion/import.mjs";

const columns="Record ID,Batch ID,Worker Category,Entity,Source URL,Supervisor Status,Supervisor Source Ledger,Country,Location,Website/Profile";
const line=(id: string,batch: string,name: string,website: string,country="Greece",source="https://example.org/source")=>
 [id,batch,"B2B",name,source,"VERIFIED NEW","source.csv",country,"Athens",website].join(",");
const ledger=(...rows: string[])=>columns+"\n"+rows.join("\n")+"\n";

function imported(result: Awaited<ReturnType<typeof importVerifiedLedger>>) {if(!("rawRows" in result)) throw new Error("Expected successful import"); return result;}

describe("verified ledger Neon intake", {concurrency:false},()=>{
 let fixture: DatabaseFixture;
 before(async()=>{fixture=await createDatabaseFixture();await applyMigrations(fixture.pool);});
 after(async()=>{if(fixture) await fixture.dispose();});
 const b1="B2B-20261002-B001",b2="B2B-20261002-B002";
 const a=line(b1+"-R001",b1,"First Shop","https://first-shop.example");
 const b=line(b1+"-R002",b1,"Second Shop","https://second-shop.example");
 test("preserves original IDs and immutable raw evidence; replay is idempotent",async()=>{
   const csv=ledger(a,b);
   const first=imported(await importVerifiedLedger(fixture.pool,csv,{filename:"sample.csv"}));
   assert.deepEqual([first.rawRows,first.prospects,first.conflicts,first.replayed,first.reconciliationJobs],[2,2,0,0,2]);
   const repeated=imported(await importVerifiedLedger(fixture.pool,csv,{filename:"sample.csv"}));
   assert.equal(repeated.replayed,2);assert.equal(repeated.prospects,0);assert.equal(repeated.reconciliationJobs,0);
   const jobs=await fixture.pool.query("SELECT type,payload->>'recordId' AS record_id FROM jobs WHERE type='reconcile_identity' ORDER BY record_id");
   assert.deepEqual(jobs.rows.map(row=>row.record_id),[b1+"-R001",b1+"-R002"]);
   const {rows:[count]}=await fixture.pool.query(
     "SELECT (SELECT count(*)::int FROM import_batches) batches,(SELECT count(*)::int FROM import_rows) rows,(SELECT count(*)::int FROM prospects) prospects");
   assert.deepEqual([count.batches,count.rows,count.prospects],[1,2,2]);
   const source=await fixture.pool.query("SELECT record_id,original_source_evidence,verification_status FROM prospects ORDER BY record_id");
   assert.equal(source.rows[0].record_id,b1+"-R001");
   assert.equal(source.rows[0].verification_status,"unverified");
   assert.equal(source.rows[0].original_source_evidence.sourceUrl,"https://example.org/source");
 });
 test("different verified files can contribute distinct rows from the same original batch",async()=>{
   const extra=line(b1+"-R003",b1,"Third Shop","https://third-shop.example");
   const result=imported(await importVerifiedLedger(fixture.pool,ledger(extra),{filename:"second-supervisor-file.csv"}));
   assert.equal(result.rawRows,1); assert.equal(result.prospects,1);
   const batches=await fixture.pool.query("SELECT original_source_evidence->>'sourceBatch' AS original_batch,source_batch AS audit_batch FROM import_batches ORDER BY created_at");
   assert.equal(batches.rows.length,2);
   assert.ok(batches.rows.every(r=>r.original_batch===b1 && r.audit_batch.startsWith(b1+"#")));
 });
 test("new batch with same canonical domain is audited for manual review",async()=>{
   const id=b2+"-R001";
   const result=imported(await importVerifiedLedger(fixture.pool,ledger(line(id,b2,"Different Trade Name","https://first-shop.example")),{filename:"another.csv"}));
   assert.equal(result.conflicts,1);assert.equal(result.prospects,0);assert.equal(result.rawRows,1);assert.equal(result.reconciliationJobs,0);
   const {rows:[conflict]}=await fixture.pool.query("SELECT conflict_kind,existing_record_id FROM identity_conflicts ORDER BY created_at DESC LIMIT 1");
   assert.equal(conflict.conflict_kind,"domain_collision");
   assert.equal(conflict.existing_record_id,b1+"-R001");
 });
 test("invalid verified status rejects full file before any writes",async()=>{
   const pending=line("B2B-20261002-B003-R001","B2B-20261002-B003","Waiting Shop","https://waiting.example").replace("VERIFIED NEW","CANDIDATE");
   const report=await importVerifiedLedger(fixture.pool,ledger(pending));
   assert.equal(report.status,"rejected");
   const {rows:[count]}=await fixture.pool.query("SELECT count(*)::int AS n FROM import_batches");
   assert.equal(count.n,3);
 });
 test("social-only countryless records use the supplied account identity",async()=>{
   const batch="B2B-20261002-B004";
   const result=imported(await importVerifiedLedger(fixture.pool,ledger(line(batch+"-R001",batch,"Public Seller","https://instagram.com/example","")),{filename:"social.csv"}));
   assert.equal(result.deferred,0);assert.equal(result.rawRows,1);assert.equal(result.prospects,1);
   const {rows:[p]}=await fixture.pool.query("SELECT canonical_profile_url,country FROM prospects WHERE record_id=$1",[batch+"-R001"]);
   assert.equal(p.canonical_profile_url,"https://instagram.com/example/");assert.equal(p.country,null);
 });
 test("same display name on distinct accounts stays separate; repeated account becomes a conflict",async()=>{
   const batch="B2B-20261002-B005";
   const result=imported(await importVerifiedLedger(fixture.pool,ledger(
     line(batch+"-R001",batch,"Same Name","https://twitch.tv/firstcreator"),
     line(batch+"-R002",batch,"Same Name","https://twitch.tv/secondcreator"),
     line(batch+"-R003",batch,"Different Name","https://www.twitch.tv/FirstCreator?ref=test")
   )));
   assert.equal(result.prospects,2);assert.equal(result.conflicts,1);
   const {rows:[c]}=await fixture.pool.query("SELECT conflict_kind FROM identity_conflicts WHERE existing_record_id=$1",[batch+"-R001"]);
   assert.equal(c.conflict_kind,"profile_collision");
 });
 test("identity mapper never treats social media as a company domain",()=>{
   const identity=identityOf({rawPayload:{"Entity":"Public Seller","Country":"","Location":"", "Website/Profile":"https://instagram.com/example"}});
   assert.equal(identity.canonicalDomain,null);
   assert.equal(identity.country,null);
 });
 test("V5.1 worker claims import as unchecked evidence, not supervisor approval",async()=>{
   const batch="B2B-20261006-B001";
   const headers=["Record ID","Batch ID","Worker Category","Entity","Source URL","Source Platform","Local Dedupe","Global Dedupe","Sync Status","Country","Location"];
   const rows=Array.from({length:100},(_,index)=>[
     `${batch}-R${String(index+1).padStart(3,"0")}`,batch,"B2B",`Worker Shop ${index+1}`,`https://worker-shop-${index+1}.example.gr/contact`,
     "XO / official site / public business evidence","PASSED — 100 unique identities; no duplicate phones",
     "PASSED — no exact/fuzzy collision found against available VYRO B2B + Supervisor Verified + Master Quick-Dedupe universe",
     "VERIFIED NEW — READY FOR LIBRARY PERSISTENCE — MASTER_SYNC_PENDING","Greece","Athens"
   ].join(","));
   const csv=headers.join(",")+"\n"+rows.join("\n")+"\n";
   const result=imported(await importVerifiedLedger(fixture.pool,csv,{filename:"v51-worker.csv"}));
   assert.deepEqual([result.rawRows,result.prospects,result.conflicts,result.reconciliationJobs],[100,100,0,100]);
   const {rows:[evidence]}=await fixture.pool.query("SELECT original_source_evidence FROM import_batches WHERE source_batch LIKE $1 ORDER BY created_at DESC LIMIT 1",[batch+"#%"]);
   assert.equal(evidence.original_source_evidence.mode,"worker_v51");
   assert.equal(evidence.original_source_evidence.certification,"worker_claim_only");
   const {rows:[state]}=await fixture.pool.query("SELECT count(*)::int AS n, count(*) FILTER (WHERE p.verification_status='unverified' AND p.identity_status='unchecked')::int AS unchecked FROM prospects p JOIN import_batches b ON p.source_batch_id=b.batch_id WHERE b.source_batch LIKE $1",[batch+"#%"]);
   assert.deepEqual([state.n,state.unchecked],[100,100]);
 });
});
