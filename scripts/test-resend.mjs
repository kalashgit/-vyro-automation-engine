// Read-only unless an explicit --send flag AND single-recipient allowlist are provided.
import { runSelfTest } from "../src/modules/outreach/resend-self-test.mjs";
const flags=process.argv.slice(2);
if(flags.some(x=>x!=="--dry-run"&&x!=="--send") || flags.length!==1){
 console.error("Usage: node scripts/test-resend.mjs --dry-run|--send");
 process.exitCode=2;
}else{
 try{
   const result=await runSelfTest({
     to:process.env.VYRO_TEST_TO,from:process.env.VYRO_TEST_FROM,
     allowedTo:process.env.VYRO_TEST_ALLOWED_TO,
     testId:process.env.VYRO_TEST_ID,
     apiKey:process.env.RESEND_API_KEY,
     confirmSend:flags[0]==="--send"
   });
   console.log(JSON.stringify(result,null,2));
 }catch(e){console.error(e instanceof Error?e.message:"Email test failed");process.exitCode=1;}
}
