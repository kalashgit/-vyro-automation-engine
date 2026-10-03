/** Fail-closed, side-effect-free recipient eligibility check. Not a sender. */
export interface RecipientEvidence {
  recordId: string; email: string; sourceUrl: string | null;
  identityStatus: string; prospectVerificationStatus: string; relevanceStatus: string;
  contactabilityStatus: string; emailVerificationStatus: string;
  emailVerifiedAt: Date | null; suppressionStatus: string;
  suppressionCheckedAt: Date | null; suppressedEmail: boolean | null; blocked: boolean;
}
export function normalizeEmail(v: unknown): string | null {
  if(typeof v !== "string") return null;
  const email=v.trim().toLowerCase();
  return email.length <=254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : null;
}
function recent(date:Date|null,now:Date,maxAge:number):boolean {
  return date instanceof Date && Number.isFinite(date.getTime()) &&
    date.getTime()<=now.getTime() && date.getTime()>=now.getTime()-maxAge;
}
export function evaluateRecipient(e:RecipientEvidence,now=new Date()) {
  if(!Number.isFinite(now.getTime())) throw new Error("Invalid clock");
  const reasons:string[]=[];
  const normalizedEmail=normalizeEmail(e.email);
  if(!/^[A-Z0-9]+-[A-Z0-9-]+$/.test(e.recordId)) reasons.push("INVALID_RECORD");
  if(!normalizedEmail) reasons.push("INVALID_EMAIL");
  try {const url=new URL(e.sourceUrl??"");
    if(url.protocol!=="https:"||!url.hostname) reasons.push("SOURCE_NOT_SECURE");
  } catch {reasons.push("SOURCE_NOT_SECURE");}
  if(e.identityStatus!=="certified") reasons.push("IDENTITY_NOT_CERTIFIED");
  if(e.prospectVerificationStatus!=="verified") reasons.push("PROSPECT_NOT_VERIFIED");
  if(e.relevanceStatus!=="relevant") reasons.push("NOT_RELEVANT");
  if(e.contactabilityStatus!=="contactable") reasons.push("NOT_CONTACTABLE");
  if(e.emailVerificationStatus!=="verified" ||
      !recent(e.emailVerifiedAt,now,30*86400000)) reasons.push("EMAIL_NOT_CURRENTLY_VERIFIED");
  if(e.suppressionStatus!=="passed" ||
      !recent(e.suppressionCheckedAt,now,86400000) ||
      e.suppressedEmail!==false) reasons.push("SUPPRESSION_NOT_CLEARED");
  if(e.blocked) reasons.push("RECIPIENT_BLOCKED");
  return {eligible:reasons.length===0,reasons,normalizedEmail};
}
