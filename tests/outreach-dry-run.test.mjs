import assert from "node:assert/strict";
import { test } from "node:test";
import { checkOutreachEligibility } from "../src/modules/outreach/dry-run.mjs";
const base={identity_status:"certified",verification_status:"verified",suppression_status:"passed",relevance_status:"relevant",contactability_status:"contactable"};
const contact={channel:"email",value:"fixture@example.org",source_url:"https://example.org/contact",verification_status:"verified"};
test("blocks outreach to database-reconciled but unverified contacts",()=>{
 const p={...base,verification_status:"unverified",suppression_status:"unchecked",relevance_status:"unknown",contactability_status:"unknown"};
 const preview=checkOutreachEligibility(p,[{...contact,verification_status:"unverified"}]);
 assert.equal(preview.eligible,false);
 assert.deepEqual(preview.reasons,["PROSPECT_NOT_VERIFIED","SUPPRESSION_NOT_PASSED","RELEVANCE_NOT_APPROVED","NOT_CONTACTABLE","NO_VERIFIED_EMAIL_WITH_SOURCE"]);
 assert.equal(preview.sent,0);
});
test("verified contact alone cannot bypass suppression",()=>{
 const preview=checkOutreachEligibility({...base,suppression_status:"suppressed"},[contact]);
 assert.equal(preview.eligible,false);
 assert.deepEqual(preview.reasons,["SUPPRESSION_NOT_PASSED"]);
});
test("missing source blocks even a purportedly verified address",()=>{
 const preview=checkOutreachEligibility(base,[{...contact,source_url:""}]);
 assert.equal(preview.eligible,false);
 assert.deepEqual(preview.reasons,["NO_VERIFIED_EMAIL_WITH_SOURCE"]);
});
test("all satisfied conditions allow preview eligibility but never send",()=>{
 const preview=checkOutreachEligibility(base,[contact]);
 assert.equal(preview.eligible,true);
 assert.equal(preview.mode,"DRY_RUN");
 assert.equal(preview.sent,0);
});
