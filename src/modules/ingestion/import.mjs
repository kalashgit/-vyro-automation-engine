// Transactional, operator-triggered intake. NO automatic outreach or queue dispatch.
import { validateLedger } from "./ledger.mjs";

const countryCodes = new Map([["greece","GR"],["ελλάδα","GR"],["hellas","GR"],["gr","GR"],["germany","DE"],["de","DE"],["italy","IT"],["it","IT"],["poland","PL"],["pl","PL"],["cyprus","CY"],["cy","CY"],["austria","AT"],["at","AT"],["france","FR"],["fr","FR"],["spain","ES"],["es","ES"],["united kingdom","GB"],["uk","GB"],["gb","GB"]]);
const socialHosts = new Set(["instagram.com","facebook.com","linkedin.com","tiktok.com","youtube.com","x.com","twitter.com","wa.me","maps.google.com"]);
function cleanName(value) { const name=value?.normalize("NFKC").trim().toLowerCase().replace(/\s+/g," "); return name && name.length<=300? name:null; }
function domain(value) {
  if (!value || !/^https?:\/\//i.test(value)) return null;
  try {
    const u=new URL(value), hostname=u.hostname.toLowerCase().replace(/^www\./,"");
    if(!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hostname)
      ||hostname.length>253||socialHosts.has(hostname)) return null;
    return hostname;
  } catch { return null; }
}
export function identityOf(row) {
  const raw=row.rawPayload;
  const country=countryCodes.get((raw.Country||"").trim().toLowerCase()) || null;
  const name=cleanName(raw.Entity);
  const region=cleanName(raw.Location)?.slice(0,200) ?? null;
  const site=domain(raw["Website/Profile"]||"");
  return {canonicalDomain:site,normalizedCompanyName:name,country,region};
}
function sameSource(a,b) { return a?.csvSha256===b?.csvSha256 && a?.sourceBatch===b?.sourceBatch; }

/** All rows must validate before opening a transaction. No implicit "VERIFIED" database promotion. */
export async function importVerifiedLedger(pool,csv,options={}) {
  const report=validateLedger(csv,{filename:options.filename,requireSupervisorVerified:true});
  if(report.rejected.length) return {status:"rejected",total:report.total,errors:report.rejected};
  if(report.accepted.length===0) throw new Error("No eligible ledger rows.");
  if(report.total>1000) throw new Error("Ledger exceeds the 1,000-row intake limit.");
  const client=await pool.connect();let inTransaction=false;
  const totals={status:"imported",total:report.total,batches:0,rawRows:0,prospects:0,conflicts:0,deferred:0,replayed:0};
  try {
    await client.query("BEGIN");inTransaction=true;
    // Serialize imports across processes; prevents two replays racing on the same batch key.
    for(const sourceKey of report.batches.sort()){
      const [worker,...batchParts]=sourceKey.split("|");const batch=batchParts.join("|");
      const records=report.accepted.filter(r=>r.sourceWorker===worker && r.sourceBatch===batch);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",[sourceKey]);
      const evidence={csvSha256:report.sha256,sourceBatch:batch,filename:options.filename||"",mode:"supervisor_verified",certification:"source_claim_only"};
      const existing=await client.query("SELECT batch_id,original_source_evidence,raw_discovered_count FROM import_batches WHERE source_worker=$1 AND source_batch=$2",[worker,batch]);
      if(existing.rows.length){
        const prev=existing.rows[0];
        if(!sameSource(prev.original_source_evidence,evidence)||Number(prev.raw_discovered_count)!==records.length)
          throw new Error("Existing source batch has different evidence: "+sourceKey);
        const audit=await client.query("SELECT count(*)::integer AS n FROM import_rows WHERE batch_id=$1",[prev.batch_id]);
        if(audit.rows[0].n!==records.length) throw new Error("Incomplete existing raw audit: "+sourceKey);
        totals.replayed+=records.length;continue;
      }
      const inserted=await client.query(
        "INSERT INTO import_batches(source_worker,source_batch,original_source_evidence,raw_discovered_count) VALUES($1,$2,$3::jsonb,$4) RETURNING batch_id",
        [worker,batch,JSON.stringify(evidence),records.length]);
      const batchId=inserted.rows[0].batch_id;totals.batches++;
      for(const [index,record] of records.entries()){
        const {rows:[audit]}=await client.query(
          "INSERT INTO import_rows(batch_id,row_number,raw_record_id,raw_payload) VALUES($1,$2,$3,$4::jsonb) RETURNING import_row_id",
          [batchId,index+1,record.recordId,JSON.stringify(record.rawPayload)]);
        totals.rawRows++;
        const ident=identityOf(record);
        if(!ident.canonicalDomain && !(ident.normalizedCompanyName && ident.country)) {totals.deferred++;continue;}
        // Review collisions rather than deleting a source row or reassigning an existing ID.
        const found=await client.query(
          "SELECT record_id,canonical_domain,normalized_company_name,country,region FROM prospects WHERE record_id=$1 OR ($2::text IS NOT NULL AND canonical_domain=$2) OR ($3::text IS NOT NULL AND $4::text IS NOT NULL AND normalized_company_name=$3 AND country=$4 AND COALESCE(region,'')=COALESCE($5::text,'')) ORDER BY CASE WHEN record_id=$1 THEN 0 WHEN canonical_domain=$2 THEN 1 ELSE 2 END LIMIT 1",
          [record.recordId,ident.canonicalDomain,ident.normalizedCompanyName,ident.country,ident.region]);
        if(found.rows.length){
          const other=found.rows[0];
          const kind=other.record_id===record.recordId?"duplicate_record_id":other.canonical_domain && other.canonical_domain===ident.canonicalDomain?"domain_collision":"compound_identity_collision";
          await client.query("INSERT INTO identity_conflicts(import_row_id,existing_record_id,conflict_kind,evidence) VALUES($1,$2,$3,$4::jsonb)",
            [audit.import_row_id,other.record_id,kind,JSON.stringify({incomingRecordId:record.recordId,sourceBatch:batch,sourceWorker:worker})]);
          totals.conflicts++;continue;
        }
        // Unique indexes remain final safety net under concurrent imports from different source batches.
        const saved=await client.query(
          "INSERT INTO prospects(record_id,source_batch_id,source_worker,original_source_evidence,canonical_domain,normalized_company_name,country,region,category) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING record_id",
          [record.recordId,batchId,worker,JSON.stringify(record.originalSourceEvidence),ident.canonicalDomain,ident.normalizedCompanyName,ident.country,ident.region,worker]);
        if(saved.rows.length) totals.prospects++;
        else {
          const winner=await client.query(
            "SELECT record_id,canonical_domain FROM prospects WHERE record_id=$1 OR ($2::text IS NOT NULL AND canonical_domain=$2) OR ($3::text IS NOT NULL AND $4::text IS NOT NULL AND normalized_company_name=$3 AND country=$4 AND COALESCE(region,'')=COALESCE($5::text,'')) LIMIT 1",
            [record.recordId,ident.canonicalDomain,ident.normalizedCompanyName,ident.country,ident.region]);
          if(!winner.rows.length) throw new Error("Identity conflict without surviving prospect.");
          const other=winner.rows[0];
          const kind=other.record_id===record.recordId?"duplicate_record_id":other.canonical_domain===ident.canonicalDomain?"domain_collision":"compound_identity_collision";
          await client.query("INSERT INTO identity_conflicts(import_row_id,existing_record_id,conflict_kind,evidence) VALUES($1,$2,$3,$4::jsonb)",
            [audit.import_row_id,other.record_id,kind,JSON.stringify({incomingRecordId:record.recordId,sourceBatch:batch,sourceWorker:worker})]);
          totals.conflicts++;
        }
      }
    }
    await client.query("COMMIT");inTransaction=false;
    return totals;
  } catch(error){
    if(inTransaction) await client.query("ROLLBACK");
    throw error;
  } finally {client.release();}
}
