// VYRO ledger intake: pure validation/normalization; no database or outreach side effects.
import { createHash } from "node:crypto";

export function parseCsv(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("Ledger CSV is empty.");
  const rows = []; let row = []; let field = ""; let quoted = false;
  for (let i=0; i<text.length; i++) {
    const ch=text[i];
    if (quoted) {
      if (ch === '"' && text[i+1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted=false;
      else field+=ch;
    } else if (ch === '"' && field === "") quoted=true;
    else if (ch === ",") { row.push(field); field=""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch==="\r" && text[i+1]==="\n") i++;
      row.push(field); field="";
      if (row.some(v=>v.trim())) rows.push(row);
      row=[];
    } else if (ch === '"') throw new Error("Malformed CSV quote.");
    else field+=ch;
  }
  if (quoted) throw new Error("Unterminated CSV quotation.");
  row.push(field); if(row.some(v=>v.trim())) rows.push(row);
  if(rows.length<2) throw new Error("Expected header and ledger rows.");
  const headers=rows.shift().map((h)=>h.replace(/^\uFEFF/,"").trim());
  if(new Set(headers).size!==headers.length) throw new Error("Duplicate CSV header.");
  for(const required of ["Record ID","Batch ID","Worker Category","Entity","Source URL"]) {
    if(!headers.includes(required)) throw new Error("Missing ledger column: "+required);
  }
  return rows.map((values,i)=>{
    if(values.length!==headers.length) throw new Error("Column mismatch on CSV data row "+(i+2));
    return Object.fromEntries(headers.map((header,index)=>[header,values[index].trim()]));
  });
}
function safeText(value,max=200) {return typeof value==="string" && value.length>0 && value.length<=max && !value.includes("\0");}
export function validateLedger(csv, options={}) {
  const rows=parseCsv(csv), seenIds=new Set(), rejected=[], accepted=[];
  const aliases=new Map([["B2B","B2B"],["B2C","B2C"],["RES","RES"],["BRK","BRK"],["CRE","CRE"],["COM","COM"],["SUP","SUP"],["Supply / Strategic Partner","SUP"],["B2C Customer","B2C"],["Broker / Referral Partner","BRK"],["B2B Buyer","B2B"],["Reseller","RES"],["Creator / Influencer","CRE"],["Community / Distribution Owner","COM"]]);
  const originalHash=createHash("sha256").update(csv).digest("hex");
  for(const [index,row] of rows.entries()){
    const id=row["Record ID"],batch=row["Batch ID"],category=aliases.get(row["Worker Category"]);
    let reason=null;
    if(!safeText(id) || !safeText(batch) || !category) reason="invalid_source_identity";
    else if(!batch.startsWith(category+"-") || !id.startsWith(batch+"-")) reason="id_batch_mismatch";
    else if(seenIds.has(id)) reason="duplicate_record_id_in_file";
    else if(!safeText(row.Entity,300) || !safeText(row["Source URL"],2048)) reason="missing_identity_or_source";
    else if(!/^https?:\/\//i.test(row["Source URL"])) reason="invalid_source_url";
    else if(options.requireSupervisorVerified && row["Supervisor Status"]!=="VERIFIED NEW") reason="not_supervisor_verified";
    if(reason) rejected.push({rowNumber:index+2,recordId:id||null,reason});
    else {
      seenIds.add(id);
      accepted.push({recordId:id,sourceBatch:batch,sourceWorker:category,
        originalSourceEvidence:{sourceUrl:row["Source URL"],sourceLedger:row["Supervisor Source Ledger"]||options.filename||"",csvSha256:originalHash},
        rawPayload:row,sourceRowNumber:index+2});
    }
  }
  return {sha256:originalHash,total:rows.length,accepted,rejected,
    // Source counts are raw ledger counts, never certified unique across other files.
    batches:[...new Set(accepted.map(r=>r.sourceWorker+"|"+r.sourceBatch))]};
}
