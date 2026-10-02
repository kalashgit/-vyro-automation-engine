// Preview-only outreach gate. No message transport, providers, or side effects.
export function checkOutreachEligibility(prospect,contacts){
 const reasons=[];
 if(prospect?.identity_status!=="certified") reasons.push("IDENTITY_NOT_RECONCILED");
 if(prospect?.verification_status!=="verified") reasons.push("PROSPECT_NOT_VERIFIED");
 if(prospect?.suppression_status!=="passed") reasons.push("SUPPRESSION_NOT_PASSED");
 if(prospect?.relevance_status!=="relevant") reasons.push("RELEVANCE_NOT_APPROVED");
 if(prospect?.contactability_status!=="contactable") reasons.push("NOT_CONTACTABLE");
 const candidates=Array.isArray(contacts)?contacts.filter(x=>
   x?.channel==="email" && x?.verification_status==="verified" &&
   typeof x?.value==="string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x.value) &&
   typeof x?.source_url==="string" && /^https?:\/\//i.test(x.source_url)): [];
 if(candidates.length===0) reasons.push("NO_VERIFIED_EMAIL_WITH_SOURCE");
 return {eligible:reasons.length===0,reasons,verifiedEmailCount:candidates.length,mode:"DRY_RUN",sent:0};
}
