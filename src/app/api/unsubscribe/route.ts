import {verifyUnsubscribeToken} from "../../../modules/outreach/unsubscribe-token.mjs";
import {getDatabasePool,withTransaction} from "../../../modules/database/client";
export const runtime="nodejs";export const dynamic="force-dynamic";
const headers={"Cache-Control":"no-store","Referrer-Policy":"no-referrer"};
export async function POST(request:Request){
 const secret=process.env.UNSUBSCRIBE_TOKEN_SECRET;
 if(!secret||secret.length<32)return new Response("Unsubscribe service temporarily unavailable.",{status:503,headers});
 const form=await request.formData().catch(()=>null);
 const token=form?.get("token");
 const email=verifyUnsubscribeToken(typeof token==="string"?token:"",secret);
 if(!email)return new Response("Invalid unsubscribe link.",{status:400,headers});
 try{
  await withTransaction(getDatabasePool(),async client=>{
   await client.query("INSERT INTO email_suppressions(email,reason) VALUES ($1,'recipient_unsubscribe') ON CONFLICT(email) DO NOTHING",[email]);
   await client.query("UPDATE prospects SET suppression_status='suppressed',suppression_reason='recipient_unsubscribe',suppression_checked_at=NOW(),updated_at=NOW() WHERE record_id IN (SELECT record_id FROM contact_points WHERE channel='email' AND lower(value)=$1)",[email]);
  });
  return new Response("<!doctype html><html><head><meta name='referrer' content='no-referrer'></head><body style='font-family:Arial;padding:40px'><h1>VYRO</h1><p>You have been unsubscribed from commercial emails.</p></body></html>",{headers:{...headers,"Content-Type":"text/html; charset=utf-8"}});
 }catch{return new Response("Unable to process request. Please try again later.",{status:503,headers});}
}
