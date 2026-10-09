import test from "node:test";
import assert from "node:assert/strict";
import {deliverWithResend} from "../src/modules/outreach/resend-adapter.ts";
const q={reservationId:"11111111-1111-4111-8111-111111111111",
from:"VYRO Sales <sales@vyro.gr>",to:"approved@example.gr",subject:"Test",text:"Hello"};
test("disabled adapter performs no network request",async()=>{
 let called=false;
 await assert.rejects(deliverWithResend(q,{apiKey:"test",enabled:false,
 fetcher:(async()=>{called=true;throw Error("no")}) as typeof fetch}),/OUTBOUND_DISABLED/);
 assert.equal(called,false);
});
test("accepted delivery uses unique idempotency key",async()=>{
 let init:RequestInit|undefined;
 const r=await deliverWithResend(q,{apiKey:"test",enabled:true,fetcher:
 (async(_url,request)=>{init=request;return new Response(JSON.stringify({id:"provider-123"}),{status:200});}) as typeof fetch});
 assert.deepEqual(r,{status:"accepted",providerMessageId:"provider-123"});
 assert.equal((init?.headers as Record<string,string>)["Idempotency-Key"],
 "vyro/"+q.reservationId);
});
test("network uncertainty never reports a safely rejected send",async()=>{
 const r=await deliverWithResend(q,{apiKey:"test",enabled:true,
 fetcher:(async()=>{throw Error("timeout")}) as typeof fetch});
 assert.deepEqual(r,{status:"unknown"});
});
test("provider auth validation errors are marked rejected",async()=>{
 const r=await deliverWithResend(q,{apiKey:"test",enabled:true,
 fetcher:(async()=>new Response("",{status:401})) as typeof fetch});
 assert.deepEqual(r,{status:"rejected",httpStatus:401});
});
