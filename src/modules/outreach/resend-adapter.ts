/** Resend delivery adapter. No automatic retries on ambiguous failures.
 * This adapter is NOT connected to the worker, and must only receive
 * recipients after the DB reservation and send-time eligibility checks.
 */
export type DeliveryResult =
 | {status:"accepted";providerMessageId:string}
 | {status:"rejected";httpStatus:number}
 | {status:"unknown"};
export interface DeliveryRequest {
 reservationId:string; from:string; to:string; subject:string; text:string;
}
type Fetcher=typeof fetch;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function deliverWithResend(
 request:DeliveryRequest,
 options:{apiKey:string;enabled:boolean;fetcher?:Fetcher}
):Promise<DeliveryResult> {
 if(!options.enabled) throw new Error("OUTBOUND_DISABLED");
 if(!UUID.test(request.reservationId) ||
   !/^.{1,100}\s<[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$/.test(request.from) ||
   !/^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(request.to) ||
   !request.subject.trim() || request.subject.length>250 ||
   !request.text.trim() || request.text.length>10000 ||
   !options.apiKey?.trim()) throw new Error("INVALID_SEND_CONFIGURATION");
 const fetcher=options.fetcher??fetch;
 let response:Response;
 try {
   response=await fetcher("https://api.resend.com/emails",{
     method:"POST",
     headers:{"Authorization":`Bearer ${options.apiKey}`,
       "Content-Type":"application/json",
       "Idempotency-Key":`vyro/${request.reservationId}`},
     body:JSON.stringify({from:request.from,to:[request.to],
       subject:request.subject,text:request.text}),
     signal:AbortSignal.timeout(15000)
   });
 }catch{
   // Network/timeout could occur after provider acceptance.
   return {status:"unknown"};
 }
 if(response.ok) {
   try {
     const json:unknown=await response.json();
     if(typeof json==="object" && json!==null && "id" in json &&
        typeof json.id==="string" && json.id.length>0)
       return {status:"accepted",providerMessageId:json.id};
   }catch{}
   return {status:"unknown"};
 }
 // Only documented validation/auth responses guarantee no request acceptance.
 if([400,401,403,422].includes(response.status))
   return {status:"rejected",httpStatus:response.status};
 return {status:"unknown"};
}
