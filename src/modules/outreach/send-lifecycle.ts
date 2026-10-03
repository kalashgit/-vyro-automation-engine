import type {Pool} from "pg";
import {withTransaction} from "../database/client.ts";
/**
 * A sender must claim a reserved row before calling the provider.
 * Failed/unknown provider responses are NEVER automatically retried:
 * a provider may have accepted the message before the connection failed.
 */
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function claimSend(pool:Pool,reservationId:string) {
 if(!UUID.test(reservationId)) return false;
 return withTransaction(pool,async client=>{
   const r=await client.query(`UPDATE outbound_reservations
     SET status='sending',updated_at=clock_timestamp()
     WHERE reservation_id=$1::uuid AND status='reserved'
     RETURNING reservation_id`,[reservationId]);
   return r.rowCount===1;
 });
}
export async function completeSend(pool:Pool,reservationId:string,
 outcome:{kind:"accepted";providerMessageId:string} |
         {kind:"unknown"} | {kind:"failed_before_send"}) {
 if(!UUID.test(reservationId)) return false;
 if(outcome.kind==="accepted" &&
    (typeof outcome.providerMessageId!=="string" || !outcome.providerMessageId.trim() ||
     outcome.providerMessageId.length>250)) return false;
 return withTransaction(pool,async client=>{
   const status=outcome.kind==="accepted"?"sent":
      outcome.kind==="unknown"?"delivery_unknown":"failed_before_send";
   const id=outcome.kind==="accepted"?outcome.providerMessageId:null;
   const r=await client.query(`UPDATE outbound_reservations
      SET status=$2,provider_message_id=$3,updated_at=clock_timestamp()
      WHERE reservation_id=$1::uuid AND status='sending'
      RETURNING reservation_id`,[reservationId,status,id]);
   return r.rowCount===1;
 });
}
export async function cancelReserved(pool:Pool,reservationId:string) {
 if(!UUID.test(reservationId)) return false;
 return withTransaction(pool,async client=>{
   const r=await client.query(`UPDATE outbound_reservations
     SET status='cancelled',updated_at=clock_timestamp()
     WHERE reservation_id=$1::uuid AND status='reserved'
     RETURNING reservation_id`,[reservationId]);
   return r.rowCount===1;
 });
}
