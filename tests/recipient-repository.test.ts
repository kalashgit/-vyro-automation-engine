import test from "node:test";
import assert from "node:assert/strict";
import { inspectRecipient } from "../src/modules/outreach/recipient-repository.ts";
import type { Pool } from "pg";
const now=new Date("2026-10-03T12:00:00Z");
const evidence={
 record_id:"B2B-001",identity_status:"certified",verification_status:"verified",
 relevance_status:"relevant",contactability_status:"contactable",
 suppression_status:"passed",suppression_checked_at:new Date(now.getTime()-1000),
 source_url:"https://example.gr/contact",verified_at:new Date(now.getTime()-1000),
 suppressed_email:false
};
function fake(rows:Record<string,unknown>[]) {
 return { query:async(sql:string,params:unknown[])=>{
   assert.match(sql,/recipient_verification_evidence/);
   assert.match(sql,/email_suppressions/);
   assert.deepEqual(params,["B2B-001","sales@example.gr",now]);
   return { rows, rowCount:rows.length };
 }} as unknown as Pool;
}
test("recorded approved evidence and fresh suppression permit preparation",async()=>{
 const result=await inspectRecipient(fake([evidence]),"B2B-001"," SALES@EXAMPLE.GR ",now);
 assert.equal(result.eligible,true);
});
test("unreviewed imported contact remains ineligible",async()=>{
 const result=await inspectRecipient(fake([{...evidence,verified_at:null,source_url:null}]),"B2B-001","sales@example.gr",now);
 assert.equal(result.eligible,false);
});
test("an existing opt-out blocks a reviewed recipient",async()=>{
 const result=await inspectRecipient(fake([{...evidence,suppressed_email:true}]),"B2B-001","sales@example.gr",now);
 assert.ok(result.reasons.includes("SUPPRESSION_NOT_CLEARED"));
});
test("missing contact fails closed",async()=>{
 const result=await inspectRecipient(fake([]),"B2B-001","sales@example.gr",now);
 assert.equal(result.eligible,false);
});
