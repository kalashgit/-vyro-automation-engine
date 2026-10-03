import assert from "node:assert/strict";
import test from "node:test";
import {evaluateRecipient,type RecipientEvidence} from "../src/modules/outreach/recipient-gate.ts";
const now=new Date("2026-10-03T12:00:00Z");
function valid():RecipientEvidence{return {
 recordId:"B2B-001",email:" SALES@EXAMPLE.GR ",sourceUrl:"https://example.gr/contact",
 identityStatus:"certified",prospectVerificationStatus:"verified",relevanceStatus:"relevant",
 contactabilityStatus:"contactable",emailVerificationStatus:"verified",
 emailVerifiedAt:new Date(now.getTime()-1000),suppressionStatus:"passed",
 suppressionCheckedAt:new Date(now.getTime()-1000),suppressedEmail:false,blocked:false
};}
test("valid verified recipient passes",()=>{
 const r=evaluateRecipient(valid(),now);
 assert.equal(r.eligible,true);assert.equal(r.normalizedEmail,"sales@example.gr");
});
test("staged addresses cannot pass",()=>{
 const e=valid();e.emailVerificationStatus="staged";e.emailVerifiedAt=null;
 assert.ok(evaluateRecipient(e,now).reasons.includes("EMAIL_NOT_CURRENTLY_VERIFIED"));
});
test("stale suppression and opt-out fail closed",()=>{
 const e=valid();e.suppressionCheckedAt=new Date(now.getTime()-25*3600000);
 assert.ok(evaluateRecipient(e,now).reasons.includes("SUPPRESSION_NOT_CLEARED"));
 e.suppressionCheckedAt=now;e.suppressedEmail=true;
 assert.ok(evaluateRecipient(e,now).reasons.includes("SUPPRESSION_NOT_CLEARED"));
});
test("conflicts, stale verification and explicit blocks fail",()=>{
 const e=valid();e.identityStatus="conflict";e.blocked=true;
 e.emailVerifiedAt=new Date(now.getTime()-31*86400000);
 const r=evaluateRecipient(e,now);
 assert.ok(r.reasons.includes("IDENTITY_NOT_CERTIFIED"));
 assert.ok(r.reasons.includes("EMAIL_NOT_CURRENTLY_VERIFIED"));
 assert.ok(r.reasons.includes("RECIPIENT_BLOCKED"));
});
test("insecure evidence and malformed address fail",()=>{
 const e=valid();e.sourceUrl="http://example.gr";e.email="bad@@example";
 const r=evaluateRecipient(e,now);
 assert.ok(r.reasons.includes("SOURCE_NOT_SECURE"));
 assert.ok(r.reasons.includes("INVALID_EMAIL"));
});
