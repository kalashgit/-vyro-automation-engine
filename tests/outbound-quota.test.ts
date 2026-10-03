import assert from "node:assert/strict";
import test from "node:test";
import {assessOutboundCapacity} from "../src/modules/outreach/outbound-quota.ts";
const base={dailyCap:100,alreadySent:30,reserved:20,providerApproved:true,operatorApproved:true,recipientEligible:true,optedOut:false,domainAuthenticated:true,providerDailyRemaining:80};
test("counts in-flight reservations and provider allowance",()=>{
 assert.deepEqual(assessOutboundCapacity(base),{allowed:true,remaining:50,reasons:[]});
 assert.equal(assessOutboundCapacity({...base,providerDailyRemaining:12}).remaining,12);
});
test("unknown provider limit and missing approvals fail closed",()=>{
 const result=assessOutboundCapacity({...base,providerDailyRemaining:null,operatorApproved:false});
 assert.equal(result.allowed,false); assert.equal(result.remaining,0);
 assert.ok(result.reasons.includes("PROVIDER_CAP_UNKNOWN"));
});
test("blocks opt-outs and exceeding initial 100/day ceiling",()=>{
 assert.equal(assessOutboundCapacity({...base,optedOut:true}).allowed,false);
 assert.equal(assessOutboundCapacity({...base,dailyCap:1000}).allowed,false);
 assert.equal(assessOutboundCapacity({...base,alreadySent:90,reserved:10}).allowed,false);
});