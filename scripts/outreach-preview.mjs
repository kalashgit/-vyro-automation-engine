// Read-only preview. This script has no messaging adapter and performs no writes.
import { getDatabasePool } from "../src/modules/database/client.ts";
import { checkOutreachEligibility } from "../src/modules/outreach/dry-run.mjs";
const pool=getDatabasePool();
try{
 const {rows:prospects}=await pool.query("SELECT record_id,identity_status,verification_status,suppression_status,relevance_status,contactability_status FROM prospects ORDER BY record_id");
 const {rows:contacts}=await pool.query("SELECT record_id,channel,value,source_url,verification_status FROM contact_points");
 const byRecord=new Map();
 for(const c of contacts){if(!byRecord.has(c.record_id))byRecord.set(c.record_id,[]);byRecord.get(c.record_id).push(c);}
 const summary={mode:"DRY_RUN",total:prospects.length,eligible:0,blocked:0,blockedReasons:{},sent:0,transportConfigured:false};
 for(const p of prospects){
   const preview=checkOutreachEligibility(p,byRecord.get(p.record_id)||[]);
   if(preview.eligible)summary.eligible++;
   else {summary.blocked++;for(const reason of preview.reasons)summary.blockedReasons[reason]=(summary.blockedReasons[reason]||0)+1;}
 }
 console.log(JSON.stringify(summary,null,2));
}finally{await pool.end();}
