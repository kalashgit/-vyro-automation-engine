/** Fail-closed send quota policy. These are VYRO internal ceilings,
 * NOT provider allowances or permission to market to a recipient.
 * Production must check + reserve atomically in the database.
 */
export interface OutboundQuota {
  dailyCap: number;
  alreadySent: number;
  reserved: number;
  providerApproved: boolean;
  operatorApproved: boolean;
  recipientEligible: boolean;
  optedOut: boolean;
  domainAuthenticated: boolean;
  providerDailyRemaining: number | null;
}
export function assessOutboundCapacity(q: OutboundQuota) {
  const reasons: string[] = [];
  for (const key of ["dailyCap","alreadySent","reserved"] as const) {
    if (!Number.isSafeInteger(q[key]) || q[key]<0) reasons.push("INVALID_"+key.toUpperCase());
  }
  if (q.dailyCap>100) reasons.push("ABOVE_INITIAL_SAFETY_CEILING");
  if (!q.providerApproved) reasons.push("PROVIDER_NOT_APPROVED");
  if (!q.operatorApproved) reasons.push("OPERATOR_NOT_APPROVED");
  if (!q.recipientEligible) reasons.push("RECIPIENT_NOT_ELIGIBLE");
  if (q.optedOut) reasons.push("OPTED_OUT");
  if (!q.domainAuthenticated) reasons.push("DOMAIN_NOT_AUTHENTICATED");
  if (q.providerDailyRemaining===null || !Number.isSafeInteger(q.providerDailyRemaining)
      || q.providerDailyRemaining<0) reasons.push("PROVIDER_CAP_UNKNOWN");
  const localRemaining=Math.max(0,q.dailyCap-q.alreadySent-q.reserved);
  const remaining=Math.min(localRemaining, q.providerDailyRemaining??0);
  if (remaining===0) reasons.push("QUOTA_EXHAUSTED");
  return {allowed:reasons.length===0, remaining: reasons.length===0?remaining:0,reasons};
}
