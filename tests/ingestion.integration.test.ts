import assert from "node:assert/strict";
import { before,after,describe,test } from "node:test";
import { applyMigrations } from "../src/modules/database/migrate.ts";
import { createDatabaseFixture } from "./helpers/database.ts";
import { identityOf,importVerifiedLedger } from "../src/modules/ingestion/import.mjs";

const columns="Record ID,Batch ID,Worker Category,Entity,Source URL,Supervisor Status,Supervisor Source Ledger,Country,Location,Website/Profile";
const line=(id,batch,name,website,country="Greece",source="https://example.org/source")=>
 [id,batch,"B2B",name,source,"VERIFIED NEW","source.csv",country,"Athens",website].join(",");
const ledger=(...rows)=>columns+"\n"+rows.join("\n")+"\n";

describe("verified ledger Neon intake", {concurrency:false},()=>{
 let fixture;
 before(async()=>{fixture=await createDatabaseFixture();await applyMigrations(fixture.pool);});
 after(async()=>{if(fixture) await fixture.dispose();});
 const b1="B2B-20261002-B001",b2="B2B-20261002-B002";
 const a=line(b1+"-R001",b1,"First Shop","https://first-shop.example");
 const b=line(b1+"-R002",b1,"Second Shop","https://second-shop.example");
 test("preserves original IDs and immutable raw evidence; replay is idempotent",async()=>{
   const csv=ledger(a,b);
   const first=await importVerifiedLedger(fixture.pool,csv,{filename:"sample.csv"});
   assert.deepEqual([first.rawRows,first.prospects,first.conflicts,first.replayed],[2,2,0,0]);
   const repeated=await importVerifiedLedger(fixture.pool,csv,{filename:"sample.csv"});
   assert.equal(repeated.replayed,2);assert.equal(repeated.prospects,0);
   const {rows:[count]}=await fixture.pool.query(
     "SELECT (SELECT count(*)::int FROM import_batches) batches,(SELECT count(*)::int FROM import_rows) rows,(SELECT count(*)::int FROM prospects) prospects");
   assert.deepEqual([count.batches,count.rows,count.prospects],[1,2,2]);
   const source=await fixture.pool.query("SELECT record_id,original_source_evidence,verification_status FROM prospects ORDER BY record_id");
   assert.equal(source.rows[0].record_id,b1+"-R001");
   assert.equal(source.rows[0].verification_status,"unverified");
   assert.equal(source.rows[0].original_source_evidence.sourceUrl,"https://example.org/source");
 });
 test("different same-batch evidence fails closed without partial writes",async()=>{
   await assert.rejects(importVerifiedLedger(fixture.pool,ledger(a),{filename:"different.csv"}),/different evidence/);
   const {rows:[count]}=await fixture.pool.query("SELECT count(*)::int AS n FROM import_batches");
   assert.equal(count.n,1);
 });
 test("new batch with same canonical domain is audited for manual review",async()=>{
   const id=b2+"-R001";
   const result=await importVerifiedLedger(fixture.pool,ledger(line(id,b2,"Different Trade Name","https://first-shop.example")),{filename:"another.csv"});
   assert.equal(result.conflicts,1);assert.equal(result.prospects,0);assert.equal(result.rawRows,1);
   const {rows:[conflict]}=await fixture.pool.query("SELECT conflict_kind,existing_record_id FROM identity_conflicts ORDER BY created_at DESC LIMIT 1");
   assert.equal(conflict.conflict_kind,"domain_collision");
   assert.equal(conflict.existing_record_id,b1+"-R001");
 });
 test("invalid verified status rejects full file before any writes",async()=>{
   const pending=line("B2B-20261002-B003-R001","B2B-20261002-B003","Waiting Shop","https://waiting.example").replace("VERIFIED NEW","CANDIDATE");
   const report=await importVerifiedLedger(fixture.pool,ledger(pending));
   assert.equal(report.status,"rejected");
   const {rows:[count]}=await fixture.pool.query("SELECT count(*)::int AS n FROM import_batches");
   assert.equal(count.n,2);
 });
 test("social-only countryless records retain raw audit without fabricating prospect identity",async()=>{
   const batch="B2B-20261002-B004";
   const result=await importVerifiedLedger(fixture.pool,ledger(line(batch+"-R001",batch,"Public Seller","https://instagram.com/example","")),{filename:"social.csv"});
   assert.equal(result.deferred,1);assert.equal(result.rawRows,1);assert.equal(result.prospects,0);
 });
 test("identity mapper never treats social media as a company domain",()=>{
   const identity=identityOf({rawPayload:{"Entity":"Public Seller","Country":"","Location":"", "Website/Profile":"https://instagram.com/example"}});
   assert.equal(identity.canonicalDomain,null);
   assert.equal(identity.country,null);
 });
});