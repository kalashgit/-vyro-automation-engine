import type {Pool} from "pg";
import {withTransaction} from "../database/client.ts";
import {inspectRecipient} from "./recipient-repository.ts";
import {normalizeEmail} from "./recipient-gate.ts";
import {assessOutboundCapacity} from "./outbound-quota.ts";

/** Atomic reservation only; this module NEVER contacts a provider.
 * Ambiguous delivery attempts remain counted, rather than permitting duplicates.
 */
export interface ReserveRequest {
 recordId:string; email:string; campaignKey:string; dailyCap:number;
 providerDailyRemaining:number|null; providerApproved:boolean;
 domainAuthenticated:boolean; operatorApproved:boolean;
}
export async function reserveOutbound(pool:Pool, q:ReserveRequest, now=new Date()) {
 const email=normalizeEmail(q.email);
 if(!email || !/^[A-Z0-9]+-[A-Z0-9-]{1,199}$/.test(q.recordId) ||
    !/^[a-zA-Z0-9_-]{3,100}$/.test(q.campaignKey) || !Number.isFinite(now.getTime()))
   return {reserved:false,reason:"INVALID_REQUEST"};
 return withTransaction(pool,async client=>{
   // Serialize all daily reservations across processes. A database advisory lock
   // also covers the first reservation of each day (when there is no row to lock).
   const day=now.toISOString().slice(0,10);
   await client.query("SELECT pg_advisory_xact_lock(hashtext('vyro_outbound_quota'),hashtext($1))",[day]);
   const existing=await client.query(
     "SELECT reservation_id FROM outbound_reservations WHERE email_normalized=$1 AND campaign_key=$2",
     [email,q.campaignKey]);
   if(existing.rowCount) return {reserved:false,reason:"DUPLICATE_CAMPAIGN_RECIPIENT"};
   // Inspect against same transaction snapshot, after acquiring daily lock.
   const evidence=await inspectRecipient(client,q.recordId,email,now);
   const prep=await client.query(
     `SELECT 1 FROM outreach_preparations
       WHERE record_id=$1 AND email_normalized=$2 AND status='approved' AND reviewed_at IS NOT NULL`,
     [q.recordId,email]);
   const usage=await client.query(
     `SELECT count(*)::int AS used FROM outbound_reservations
       WHERE utc_day=$1 AND status IN ('reserved','sending','sent','delivery_unknown')`,[day]);
   const policy=assessOutboundCapacity({
     dailyCap:q.dailyCap,alreadySent:Number(usage.rows[0].used),
     reserved:0,providerApproved:q.providerApproved,
     operatorApproved:q.operatorApproved && Boolean(prep.rowCount),
     recipientEligible:evidence.eligible,optedOut:false,
     domainAuthenticated:q.domainAuthenticated,
     providerDailyRemaining:q.providerDailyRemaining
   });
   if(!policy.allowed) return {reserved:false,reason:policy.reasons.join(",")};
   const inserted=await client.query(
     `INSERT INTO outbound_reservations(record_id,email_normalized,campaign_key,utc_day)
       VALUES($1,$2,$3,$4) RETURNING reservation_id`,
     [q.recordId,email,q.campaignKey,day]);
   return {reserved:true,reservationId:inserted.rows[0].reservation_id as string};
 });
}
