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
