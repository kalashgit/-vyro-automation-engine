import type { Pool } from "pg";
import type { JobHandlers } from "./worker.ts";
import { JobExecutionError } from "./worker.ts";

const channels = [
 ["Email","email"],["Phone","phone"],["WhatsApp","whatsapp"],
 ["Instagram","instagram"],["Facebook","facebook"],["LinkedIn","linkedin"],
 ["Website/Profile","website"],
] as const;

function validRecordId(value: unknown): value is string {
 return typeof value==="string" && value.length<=200 && /^[A-Z0-9]+-[A-Z0-9-]+$/.test(value);
}
function contactValue(value: unknown): string | null {
 if(typeof value!=="string") return null;
 const v=value.trim();
 return v && v.length<=2048 && !v.includes("\0") ? v : null;
}

/** Local identity only: checks DB uniqueness, not external business authenticity. */
export function createAcquisitionHandlers(pool: Pool): JobHandlers {
 return {
   reconcile_identity: async (job, { signal })=>{
     const recordId=job.payload.recordId;
     if(!validRecordId(recordId)) throw new JobExecutionError("INVALID_RECORD_ID",{retryable:false});
     if(signal.aborted) return;
     const client=await pool.connect();
     try {
       await client.query("BEGIN");
       const {rows:[p]}=await client.query(
         "SELECT record_id,canonical_domain,normalized_company_name,country,region,identity_status FROM prospects WHERE record_id=$1 FOR UPDATE",[recordId]);
       if(!p) throw new JobExecutionError("UNKNOWN_RECORD_ID",{retryable:false});
       if(signal.aborted) {await client.query("ROLLBACK");return;}
       if(p.identity_status!=="unchecked"){await client.query("COMMIT");return;}
       const {rows:[result]}=await client.query(
         "SELECT count(*)::integer AS n FROM prospects WHERE record_id<>$1 AND ( ($2::text IS NOT NULL AND canonical_domain=$2) OR ($3::text IS NOT NULL AND $4::text IS NOT NULL AND normalized_company_name=$3 AND country=$4 AND COALESCE(region,'')=COALESCE($5::text,'')) )",
         [recordId,p.canonical_domain,p.normalized_company_name,p.country,p.region]);
       const {rows:[existingConflict]}=await client.query(
         "SELECT EXISTS(SELECT 1 FROM identity_conflicts WHERE existing_record_id=$1 AND review_status='pending') AS pending",[recordId]);
       if(result.n>0||existingConflict.pending){
         await client.query("UPDATE prospects SET identity_status='conflict' WHERE record_id=$1",[recordId]);
       }else{
         // Certified means unique within current database only, NOT independently verified.
         await client.query("UPDATE prospects SET identity_status='certified',identity_certified_at=clock_timestamp() WHERE record_id=$1",[recordId]);
       }
       await client.query("COMMIT");
     }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
   },
   enrich_contact: async (job,{signal})=>{
     const recordId=job.payload.recordId;
     if(!validRecordId(recordId)) throw new JobExecutionError("INVALID_RECORD_ID",{retryable:false});
     if(signal.aborted) return;
     const client=await pool.connect();
     try{
       await client.query("BEGIN");
       const {rows:[p]}=await client.query(
         "SELECT identity_status FROM prospects WHERE record_id=$1 FOR UPDATE",[recordId]);
       if(!p) throw new JobExecutionError("UNKNOWN_RECORD_ID",{retryable:false});
       if(p.identity_status!=="certified")throw new JobExecutionError("IDENTITY_NOT_READY",{retryable:false});
       const {rows:[source]}=await client.query(
         "SELECT r.raw_payload FROM import_rows r JOIN prospects p ON p.source_batch_id=r.batch_id AND p.record_id=r.raw_record_id WHERE p.record_id=$1 LIMIT 1",[recordId]);
       if(!source)throw new JobExecutionError("SOURCE_NOT_FOUND",{retryable:false});
       const raw=source.raw_payload as Record<string,unknown>;
       const evidence=contactValue(raw["Source URL"]);
       if(!evidence||!/^https?:\/\//i.test(evidence))throw new JobExecutionError("MISSING_SOURCE_URL",{retryable:false});
       if(signal.aborted){await client.query("ROLLBACK");return;}
       for(const [field,channel] of channels){
         const value=contactValue(raw[field]);
         if(!value)continue;
         await client.query(
           "INSERT INTO contact_points(record_id,channel,value,source_url) VALUES($1,$2,$3,$4) ON CONFLICT(record_id,channel,value) DO NOTHING",
           [recordId,channel,value,evidence]);
       }
       // Contact details from original ledger are staged, never implicitly verified.
       await client.query("COMMIT");
     }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
   },
   suppression_check: async (job,{signal})=>{
     const recordId=job.payload.recordId;
     if(!validRecordId(recordId))throw new JobExecutionError("INVALID_RECORD_ID",{retryable:false});
     if(signal.aborted)return;
     const client=await pool.connect();
     try {
       await client.query("BEGIN");
       const {rows:[p]}=await client.query(
         "SELECT identity_status,verification_status,relevance_status,contactability_status FROM prospects WHERE record_id=$1 FOR UPDATE",[recordId]);
       if(!p)throw new JobExecutionError("UNKNOWN_RECORD_ID",{retryable:false});
       if(p.identity_status!=="certified"||p.verification_status!=="verified"||
         p.relevance_status!=="relevant"||p.contactability_status!=="contactable") {
         throw new JobExecutionError("REVIEW_NOT_COMPLETE",{retryable:false});
       }
       const {rows:contacts}=await client.query(
         "SELECT value FROM contact_points WHERE record_id=$1 AND channel='email' AND verification_status='verified' AND source_url LIKE 'https://%'",
         [recordId]);
       if(!contacts.length)throw new JobExecutionError("NO_VERIFIED_EMAIL",{retryable:false});
       const {rows:[result]}=await client.query(
         `SELECT EXISTS(
            SELECT 1 FROM contact_points c JOIN email_suppressions s
              ON s.email_normalized=lower(btrim(c.value))
            WHERE c.record_id=$1 AND c.channel='email'
          ) AS suppressed`,[recordId]);
       if(signal.aborted){await client.query("ROLLBACK");return;}
       await client.query(
         "UPDATE prospects SET suppression_status=$2, suppression_reason=$3, suppression_checked_at=now(),updated_at=now() WHERE record_id=$1",
         [recordId,result.suppressed?"suppressed":"passed",result.suppressed?"recipient_unsubscribed":null]
       );
       await client.query("COMMIT");
     }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
   },
 };
}
