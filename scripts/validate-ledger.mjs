// Dry-run only: no database writes, email, messaging, or contact enrichment.
import { readFile } from "node:fs/promises";
import { validateLedger } from "../src/modules/ingestion/ledger.mjs";
const paths=process.argv.slice(2);
if(paths.length!==1) {
  console.error("Usage: node scripts/validate-ledger.mjs path/to/ledger.csv");
  process.exitCode=2;
} else {
  try {
    const csv=await readFile(paths[0],"utf8");
    const report=validateLedger(csv,{filename:paths[0],requireSupervisorVerified:true});
    console.log(JSON.stringify({
      filename:paths[0],sha256:report.sha256,totalRows:report.total,
      validRows:report.accepted.length,rejectedRows:report.rejected.length,
      sourceBatches:report.batches,
      rejected:report.rejected,
      mode:"dry_run_only",databaseWrites:0,outreachSent:0
    },null,2));
    if(report.rejected.length) process.exitCode=1;
  } catch(error){console.error(error instanceof Error?error.message:"Ledger validation failed");process.exitCode=1;}
}