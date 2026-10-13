import test from "node:test";
import assert from "node:assert/strict";
import {planNextStep,allocateCapacity,type PipelineSnapshot} from "../src/modules/workers/acquisition-planner.ts";
const now=new Date("2026-10-03T12:00:00Z");
const sample=():PipelineSnapshot=>({
 recordId:"B2B-001",identityStatus:"unchecked",prospectVerificationStatus:"verified",
 relevanceStatus:"relevant",contactabilityStatus:"contactable",enrichmentStatus:"pending",
 verifiedEmailCount:0,suppressionStatus:"unchecked",suppressionCheckedAt:null,
 outreachStatus:"none",blocked:false
});
test("moves through every gated stage without automatically sending",()=>{
 const p=sample();
 assert.equal(planNextStep(p,now).jobType,"reconcile_identity");
 p.identityStatus="certified";
 assert.equal(planNextStep(p,now).jobType,"enrich_contact");
 p.enrichmentStatus="complete";
 assert.equal(planNextStep(p,now).jobType,"verify_contact");
 p.verifiedEmailCount=1;
 assert.equal(planNextStep(p,now).jobType,"suppression_check");
 p.suppressionStatus="passed";p.suppressionCheckedAt=now;
 assert.equal(planNextStep(p,now).jobType,"prepare_outreach");
 p.outreachStatus="prepared";
 assert.equal(planNextStep(p,now).requiresHumanReview,true);
});
test("conflict, blocked and suppressed prospects never enter preparation",()=>{
 const p=sample();p.identityStatus="conflict";
 assert.equal(planNextStep(p,now).jobType,null);
 p.blocked=true;
 assert.equal(planNextStep(p,now).stage,"blocked");
 p.blocked=false;p.identityStatus="certified";p.enrichmentStatus="complete";
 p.verifiedEmailCount=1;p.suppressionStatus="suppressed";
 assert.equal(planNextStep(p,now).stage,"blocked");
});
test("stale suppression routes back for refresh",()=>{
 const p=sample();p.identityStatus="certified";p.enrichmentStatus="complete";
 p.verifiedEmailCount=1;p.suppressionStatus="passed";
 p.suppressionCheckedAt=new Date(now.getTime()-25*3600000);
 assert.equal(planNextStep(p,now).jobType,"suppression_check");
});
test("allocation respects budget, backlog, and stage fairness",()=>{
 const zero={identity:0,enrichment:0,verification:0,suppression:0,outreach_preparation:0};
 assert.deepEqual(allocateCapacity(zero),zero);
 const queue={identity:100,enrichment:100,verification:100,suppression:100,outreach_preparation:100};
 const shares=allocateCapacity(queue,13);
 assert.equal(Object.values(shares).reduce((a,b)=>a+b,0),13);
 assert.ok(Object.values(shares).every(v=>v>=1));
 assert.deepEqual(allocateCapacity({...zero,verification:2},13),{...zero,verification:2});
});
