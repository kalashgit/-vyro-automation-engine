import assert from "node:assert/strict";
import {test} from "node:test";
import {prepareSelfTest,runSelfTest} from "../src/modules/outreach/resend-self-test.mjs";
const options={to:"owner@example.org",from:"VYRO <test@vyro.gr>",allowedTo:"owner@example.org",testId:"test_12345678"};
test("rejects addresses outside explicit allowlist before network access",async()=>{
 let calls=0;
 await assert.rejects(runSelfTest({...options,to:"prospect@example.net",confirmSend:true,apiKey:"re_example",fetchImpl:async()=>{calls++;return {ok:true,json:async()=>({id:"x"})}}}),/NOT_ALLOWLISTED/);
 assert.equal(calls,0);
});
test("dry run never makes an HTTP request",async()=>{
 const r=await runSelfTest({...options,fetchImpl:async()=>{throw new Error("Network should not run")}});
 assert.equal(r.sent,false);
 assert.equal(r.wouldSendTo,options.to);
});
test("live test sends exactly one approved recipient and returns provider receipt",async()=>{
 let calls=0;
 const r=await runSelfTest({...options,confirmSend:true,apiKey:"re_fixture",fetchImpl:async(url,init)=>{
  calls++;assert.equal(url,"https://api.resend.com/emails");assert.equal(init.method,"POST");
  const message=JSON.parse(init.body);
  assert.deepEqual(message.to,[options.to]);assert.match(message.subject,/VYRO email integration test/);
  assert.equal(init.headers["Idempotency-Key"],"vyro-self-test-"+options.testId);
  return {ok:true,json:async()=>({id:"test_message_001"})};
 }});
 assert.equal(calls,1);assert.equal(r.messageId,"test_message_001");
});
test("requires a configured API key and handles provider error without claiming delivery",async()=>{
 await assert.rejects(runSelfTest({...options,confirmSend:true}),/RESEND_API_KEY/);
 await assert.rejects(runSelfTest({...options,confirmSend:true,apiKey:"re_fixture",fetchImpl:async()=>({ok:false,status:403})}),/status 403/);
});
test("rejects malformed test ids and malformed recipients",()=>{
 assert.throws(()=>prepareSelfTest({...options,testId:"bad"}),/Invalid test ID/);
 assert.throws(()=>prepareSelfTest({...options,to:"a@example.org,b@example.org"}),/valid email/);
});
