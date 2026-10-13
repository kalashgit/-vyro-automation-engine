import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, validateLedger } from "../src/modules/ingestion/ledger.mjs";
const header="Record ID,Batch ID,Worker Category,Entity,Source URL,Supervisor Status,Supervisor Source Ledger";
const one='RES-20261002-B003-R001,RES-20261002-B003,RES,"Beats, Bytes",https://example.org/company,VERIFIED NEW,source.csv';
const two='RES-20261002-B003-R002,RES-20261002-B003,RES,Game Store,https://example.org/games,VERIFIED NEW,source.csv';
test("parses quoted CSV values and original IDs",()=>{
  const rows=parseCsv(header+"\r\n"+one+"\r\n");
  assert.equal(rows[0].Entity,"Beats, Bytes");
  const result=validateLedger(header+"\n"+one+"\n",{requireSupervisorVerified:true,filename:"batch.csv"});
  assert.equal(result.accepted.length,1);
  assert.equal(result.accepted[0].recordId,"RES-20261002-B003-R001");
  assert.equal(result.accepted[0].sourceWorker,"RES");
  assert.equal(result.accepted[0].originalSourceEvidence.sourceUrl,"https://example.org/company");
  assert.equal(result.rejected.length,0);
});
test("flags repeated record IDs without generating new identities",()=>{
  const result=validateLedger(header+"\n"+one+"\n"+one+"\n"+two+"\n");
  assert.equal(result.total,3);
  assert.equal(result.accepted.length,2);
  assert.equal(result.rejected[0].reason,"duplicate_record_id_in_file");
});
test("unverified records rejected in verified-ledger mode",()=>{
  const csv=header+"\n"+one.replace("VERIFIED NEW","CANDIDATE")+"\n";
  const result=validateLedger(csv,{requireSupervisorVerified:true});
  assert.equal(result.accepted.length,0);
  assert.equal(result.rejected[0].reason,"not_supervisor_verified");
});
test("rejects malformed input and missing sources",()=>{
  assert.throws(()=>parseCsv("a,b\n1,\"unfinished"),/Unterminated/);
  assert.throws(()=>parseCsv("a,b\n1,2"),/Missing ledger column/);
  const invalid=one.replace("https://example.org/company","");
  assert.equal(validateLedger(header+"\n"+invalid).rejected[0].reason,"missing_identity_or_source");
});
test("repeated input produces identical fingerprint and accepted IDs",()=>{
 const csv=header+"\n"+one+"\n"+two+"\n";
 const a=validateLedger(csv),b=validateLedger(csv);
 assert.equal(a.sha256,b.sha256);
 assert.deepEqual(a.accepted.map(r=>r.recordId),b.accepted.map(r=>r.recordId));
});
test("accepts legacy supervisor category labels without rewriting the original ledger",()=>{
 const columns="Record ID,Batch ID,Worker Category,Entity,Source URL,Supervisor Status,Supervisor Source Ledger";
 const examples=[
 ["SUP","Supply / Strategic Partner"],["B2C","B2C Customer"],["BRK","Broker / Referral Partner"],["RES","RES"]];
 for(const [code,label] of examples){
  const batch=code+"-20261002-B005",id=batch+"-R001";
  const csv=columns+"\n"+[id,batch,label,"Example Shop","https://example.org/source","VERIFIED NEW","supervisor.csv"].join(",")+"\n";
  const result=validateLedger(csv,{requireSupervisorVerified:true});
  assert.equal(result.rejected.length,0,label);
  assert.equal(result.accepted[0].sourceWorker,code);
  assert.equal(result.accepted[0].rawPayload["Worker Category"],label);
 }
});
test("accepts only a complete VYRO V5.1 B2B worker-claim batch and labels the claim",()=>{
 const columns=["Record ID","Batch ID","Worker Category","Entity","Source URL","Source Platform","Local Dedupe","Global Dedupe","Sync Status","Country","Location"];
 const batch="B2B-20261006-B001";
 const rows=Array.from({length:100},(_,i)=>[
  `${batch}-R${String(i+1).padStart(3,"0")}`,batch,"B2B",`Example Shop ${i+1}`,`https://shop${i+1}.example.gr/contact`,
  "XO / official site / public business evidence","PASSED — 100 unique identities; no duplicate phones",
  "PASSED — no exact/fuzzy collision found against available VYRO B2B + Supervisor Verified + Master Quick-Dedupe universe",
  "VERIFIED NEW — READY FOR LIBRARY PERSISTENCE — MASTER_SYNC_PENDING","Greece","Athens"
 ].join(","));
 const csv=columns.join(",")+"\n"+rows.join("\n")+"\n";
 const result=validateLedger(csv,{requireSupervisorVerified:true,allowWorkerV51:true});
 assert.equal(result.total,100);
 assert.equal(result.accepted.length,100);
 assert.equal(result.rejected.length,0);
 assert.equal(result.certification,"worker_v51_claim_only");
 assert.equal(result.accepted[0].certification,"worker_v51_claim_only");
});
test("rejects partial or changed-status worker batches rather than importing a subset",()=>{
 const columns=["Record ID","Batch ID","Worker Category","Entity","Source URL","Source Platform","Local Dedupe","Global Dedupe","Sync Status"];
 const batch="B2B-20261006-B001";
 const row=i=>[`${batch}-R${String(i).padStart(3,"0")}`,batch,"B2B",`Example Shop ${i}`,`https://shop${i}.example.gr/contact`,
  "official site / public business evidence","PASSED — 100 unique identities; no duplicate phones",
  "PASSED — no exact/fuzzy collision found against available VYRO B2B + Supervisor Verified + Master Quick-Dedupe universe",
  "VERIFIED NEW — READY FOR LIBRARY PERSISTENCE — MASTER_SYNC_PENDING"].join(",");
 const partial=validateLedger(columns.join(",")+"\n"+Array.from({length:99},(_,i)=>row(i+1)).join("\n"),{requireSupervisorVerified:true,allowWorkerV51:true});
 assert.equal(partial.accepted.length,0);
 assert.ok(partial.rejected.some(x=>x.reason==="worker_v51_requires_one_complete_100_row_batch"));
 const rows=Array.from({length:100},(_,i)=>row(i+1));
 rows[99]=rows[99].replace("VERIFIED NEW — READY FOR LIBRARY PERSISTENCE — MASTER_SYNC_PENDING","MASTER_SYNC_PENDING");
 const changed=validateLedger(columns.join(",")+"\n"+rows.join("\n"),{requireSupervisorVerified:true,allowWorkerV51:true});
 assert.equal(changed.accepted.length,0);
 assert.equal(changed.rejected.length,100);
});
