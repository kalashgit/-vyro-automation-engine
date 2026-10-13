export interface BusinessIdentity {
  companyName: string;
  phone: string | null;
  location: string | null;
  officialDomain: string | null;
}
export interface PublicContactEvidence {
  sourceUrl: string;
  sourceHost: string;
  email: string;
  pageCompanyName?: string | null;
  pagePhones?: string[];
  pageLocation?: string | null;
}
export type EvidenceDecision = "substantiated" | "unresolved";

function fold(v:string):string {
  return v.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase()
    .replace(/[^a-z0-9\u0370-\u03ff]+/g," ").trim();
}
export function normalizePhone(v:string|null|undefined):string|null {
  if(!v) return null;
  let d=v.replace(/\D/g,"");
  if(d.startsWith("0030")) d=d.slice(4);
  else if(d.startsWith("30") && d.length>10) d=d.slice(2);
  return d.length>=10 ? d : null;
}
function sameHost(a:string,b:string):boolean {
  const n=(v:string)=>v.toLowerCase().replace(/^www\./,"");
  return n(a)===n(b);
}
function nameMatch(a:string,b:string|null|undefined):boolean {
  if(!b) return false;
  const x=fold(a),y=fold(b);
  return x.length>=3 && y.length>=3 && (x===y||x.includes(y)||y.includes(x));
}
function locationMatch(a:string|null,b:string|null|undefined):boolean {
  if(!a||!b) return false;
  const x=fold(a),y=fold(b);
  return x.length>=3 && y.length>=3 && (x.includes(y)||y.includes(x));
}
/** Fail closed: public listing is not delivery verification. */
export function evaluatePublicBusinessEvidence(identity:BusinessIdentity,e:PublicContactEvidence) {
  let url:URL;
  try { url=new URL(e.sourceUrl); } catch {
    return {decision:"unresolved" as EvidenceDecision,reasons:["INVALID_SOURCE_URL"],publiclyListed:false,deliveryVerified:false};
  }
  if(url.protocol!=="https:") return {decision:"unresolved" as EvidenceDecision,reasons:["SOURCE_NOT_HTTPS"],publiclyListed:false,deliveryVerified:false};
  const official=identity.officialDomain ? sameHost(url.hostname,identity.officialDomain) : false;
  const targetPhone=normalizePhone(identity.phone);
  const phoneMatched=!!targetPhone && (e.pagePhones??[]).some(p=>normalizePhone(p)===targetPhone);
  const companyMatched=nameMatch(identity.companyName,e.pageCompanyName);
  const locationMatched=locationMatch(identity.location,e.pageLocation);
  const emailDomain=e.email.toLowerCase().split("@")[1]??"";
  const domainAligned=!!identity.officialDomain && sameHost(emailDomain,identity.officialDomain);
  const reasons:string[]=[];
  if(!companyMatched) reasons.push("COMPANY_IDENTITY_NOT_MATCHED");
  if(!phoneMatched && !locationMatched) reasons.push("PHONE_OR_LOCATION_NOT_MATCHED");
  if(!official && !domainAligned) reasons.push("EMAIL_NOT_TIED_TO_OFFICIAL_DOMAIN");
  const substantiated=reasons.length===0;
  return {
    decision:(substantiated?"substantiated":"unresolved") as EvidenceDecision,
    reasons, publiclyListed:substantiated, deliveryVerified:false,
    matches:{official,companyMatched,phoneMatched,locationMatched,domainAligned}
  };
}
