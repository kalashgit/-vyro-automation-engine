import test from "node:test";
import assert from "node:assert/strict";
import {claimSend,completeSend,cancelReserved} from "../src/modules/outreach/send-lifecycle.ts";
import type {Pool} from "pg";
const id="11111111-1111-4111-8111-111111111111";
function fake(rowCounts:number[]) {
 const calls:{sql:string;params:unknown[]}[]=[];
 return {pool:{connect:async()=>({
   query:async(sql:string,params:unknown[]=[])=>{
     calls.push({sql,params});
     return {rowCount: /UPDATE outbound_reservations/.test(sql)?rowCounts.shift()??0:0};
   },release:()=>{}
 })} as unknown as Pool,calls};
}
test("only one claimant may transition reserved to sending",async()=>{
 const {pool,calls}=fake([1,0]);
 assert.equal(await claimSend(pool,id),true);
 assert.equal(await claimSend(pool,id),false);
 assert.ok(calls.filter(x=>x.sql.includes("UPDATE outbound_reservations")).every(
  x=>x.sql.includes("status='reserved'")));
});
test("unknown provider result is preserved for manual reconciliation",async()=>{
 const {pool,calls}=fake([1]);
 assert.equal(await completeSend(pool,id,{kind:"unknown"}),true);
 assert.ok(calls.some(x=>x.params.includes("delivery_unknown")));
 assert.ok(calls.some(x=>x.sql.includes("status='sending'")));
});
test("accepted provider delivery requires a message id",async()=>{
 const {pool,calls}=fake([1]);
 assert.equal(await completeSend(pool,id,{kind:"accepted",providerMessageId:""}),false);
 assert.equal(calls.length,0);
 assert.equal(await completeSend(pool,id,{kind:"accepted",providerMessageId:"msg-123"}),true);
});
test("cannot cancel a send once claimed",async()=>{
 const {pool,calls}=fake([0]);
 assert.equal(await cancelReserved(pool,id),false);
 assert.ok(calls.some(x=>x.sql.includes("status='reserved'")));
});