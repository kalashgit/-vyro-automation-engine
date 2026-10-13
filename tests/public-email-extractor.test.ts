import assert from "node:assert/strict";
import test from "node:test";
import { extractOfficialEmails,prioritizeEnrichment } from "../src/modules/enrichment/public-email-extractor.ts";
test("extracts and deduplicates public official-site candidates, not verified contacts",()=>{
 const result=extractOfficialEmails({url:"https://shop.example.gr/contact",text:"Sales@SHOP.EXAMPLE.GR sales@shop.example.gr; info [at] shop.example.gr"},"shop.example.gr");
 assert.deepEqual(result.map(x=>x.email),["info@shop.example.gr","sales@shop.example.gr"]);
 assert.ok(result.every(x=>x.reviewStatus==="pending"));
});
test("rejects third-party and insecure content",()=>{
 assert.deepEqual(extractOfficialEmails({url:"https://directory.gr",text:"info@shop.gr"},"shop.gr"),[]);
 assert.deepEqual(extractOfficialEmails({url:"http://shop.gr",text:"info@shop.gr"},"shop.gr"),[]);
});
test("puts incomplete phone-bearing B2B ahead of already verified leads",()=>{
 const result=prioritizeEnrichment([
 {recordId:"CRE-2",officialDomain:"creator.gr",existingVerifiedEmailCount:0,contactPhoneCount:0,category:"CRE"},
 {recordId:"B2B-1",officialDomain:"retail.gr",existingVerifiedEmailCount:0,contactPhoneCount:1,category:"B2B"},
 {recordId:"B2B-3",officialDomain:"ready.gr",existingVerifiedEmailCount:1,contactPhoneCount:1,category:"B2B"}
 ]);
 assert.deepEqual(result.map(x=>x.recordId),["B2B-1","CRE-2"]);
});
