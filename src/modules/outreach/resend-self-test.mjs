// Isolated email transport for a single operator-approved inbox test.
// Never accepts prospect record IDs, database recipients, or bulk recipient arrays.
import { getVyroReplyTo } from "./reply-routing.mjs";
const EMAIL=/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
function singleEmail(value,label){
 if(typeof value!=="string"||!EMAIL.test(value)||value.length>254)throw new Error(label+" must be one valid email address.");
 return value;
}
export function prepareSelfTest({to,from,allowedTo,testId,replyTo}){
 const recipient=singleEmail(to,"to"),sender=singleEmail(from,"from"),allow=singleEmail(allowedTo,"allowedTo");
 if(recipient.toLowerCase()!==allow.toLowerCase())throw new Error("SELF_TEST_RECIPIENT_NOT_ALLOWLISTED");
 if(typeof testId!=="string"||!/^[a-zA-Z0-9_-]{8,72}$/.test(testId))throw new Error("Invalid test ID");
 return {
  from:sender,to:[recipient],...(replyTo ? {reply_to:singleEmail(replyTo,"replyTo")} : {}),
  subject:"VYRO email integration test — "+testId,
  text:"VYRO test only. This message confirms the sender can reach the approved test inbox. No prospect outreach was triggered. Test ID: "+testId,
  headers:{"X-VYRO-Test-Only":"true"},
 };
}
export async function runSelfTest({to,from,allowedTo,testId,apiKey,confirmSend=false,fetchImpl=fetch,environment=process.env}){
 const payload=prepareSelfTest({to,from,allowedTo,testId,replyTo:environment.VYRO_REPLY_TO ? getVyroReplyTo(environment) : undefined});
 if(!confirmSend)return {mode:"DRY_RUN",wouldSendTo:payload.to[0],testId,sent:false};
 if(typeof apiKey!=="string"||!apiKey.startsWith("re_"))throw new Error("RESEND_API_KEY is required for a live test.");
 const response=await fetchImpl("https://api.resend.com/emails",{
  method:"POST",headers:{"Authorization":"Bearer "+apiKey,"Content-Type":"application/json","Idempotency-Key":"vyro-self-test-"+testId},
  body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)
 });
 if(!response.ok)throw new Error("Resend rejected test email; status "+response.status);
 const result=await response.json();
 if(typeof result?.id!=="string")throw new Error("Resend response lacked message ID");
 return {mode:"SELF_TEST",to:payload.to[0],testId,messageId:result.id,acceptedByProvider:true};
}
