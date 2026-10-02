// Explicit operator action; no background ingestion or outbound messaging.
import { readFile } from "node:fs/promises";
import { getDatabasePool } from "../src/modules/database/client.ts";
import { validateLedger } from "../src/modules/ingestion/ledger.mjs";
import { importVerifiedLedger } from "../src/modules/ingestion/import.mjs";
const [mode,path,...extra]=process.argv.slice(2);
if(!["--dry-run","--commit"].includes(mode)||!path||extra.length){
 console.error("Usage: node --experimental-strip-types scripts/import-ledger.mjs --dry-run|--commit ledger.csv");
 process.exitCode=2;
} else {
 try{
   const text=await readFile(path,"utf8");
   const preflight=validateLedger(text,{filename:path,requireSupervisorVerified:true});
   const summary={mode,rows:preflight.total,eligible:preflight.accepted.length,rejected:preflight.rejected.length,sourceBatches:preflight.batches,errors:preflight.rejected};
   if(mode==="--dry-run"||preflight.rejected.length) {
     console.log(JSON.stringify({...summary,databaseWrites:0,outreachSent:0},null,2));
     if(preflight.rejected.length)process.exitCode=1;
   }else {
     if(process.env.VYRO_LEDGER_IMPORT_ENABLED!=="true")throw new Error("Import is disabled; set VYRO_LEDGER_IMPORT_ENABLED=true for an explicit --commit.");
     const pool=getDatabasePool();
     try {console.log(JSON.stringify(await importVerifiedLedger(pool,text,{filename:path}),null,2));}
     finally {await pool.end();}
   }
 }catch(error){console.error(error instanceof Error?error.message:"Import failed");process.exitCode=1;}
}