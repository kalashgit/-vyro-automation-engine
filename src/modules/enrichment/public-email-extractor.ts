/** Deterministic extraction of candidate PUBLIC BUSINESS emails.
 * Never infer mailbox formats or interpret a candidate as deliverable/consented.
 * The network fetcher must separately enforce SSRF protection, robots/rate limits,
 * redirect checks, provider budgets and page-size/time limits.
 */
export interface PublicPage {
  url: string;
  text: string;
}
export interface EmailCandidate {
  email: string;
  sourceUrl: string;
  sourceKind: "official_site";
  reviewStatus: "pending";
}
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}\b/gi;
const BAD_EXTENSIONS = /\.(?:png|jpg|jpeg|webp|gif|svg|css|js|pdf|woff2?)$/i;
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}
export function extractOfficialEmails(page: PublicPage, officialDomain: string): EmailCandidate[] {
  if (typeof page.text !== "string" || page.text.length > 2_000_000 ||
      typeof officialDomain !== "string" || officialDomain.length > 253) return [];
  let parsed: URL;
  try { parsed = new URL(page.url); } catch { return []; }
  const domain = normalizeHost(officialDomain);
  const host = normalizeHost(parsed.hostname);
  if (parsed.protocol !== "https:" || !domain || host !== domain || !domain.includes(".")) return [];
  const cleaned = page.text.replace(/\s*(?:\[at\]|\(at\))\s*/gi, "@")
    .replace(/\s*(?:\[dot\]|\(dot\))\s*/gi, ".");
  const found = new Set<string>();
  for (const raw of cleaned.match(EMAIL_PATTERN) ?? []) {
    const email = raw.toLowerCase();
    if (email.length > 254 || BAD_EXTENSIONS.test(email) ||
        /^(?:example|test|sample)\./.test(email.split("@")[1]) ||
        /^(?:noreply|no-reply|donotreply)@/.test(email)) continue;
    found.add(email);
  }
  return [...found].sort().map(email => ({
    email, sourceUrl: parsed.toString(),
    sourceKind: "official_site" as const, reviewStatus: "pending" as const
  }));
}
/** Prioritize verified domains and channel gaps, not indiscriminate page crawling. */
export interface EnrichmentTarget {
  recordId: string;
  officialDomain: string | null;
  existingVerifiedEmailCount: number;
  contactPhoneCount: number;
  category: "B2B" | "RES" | "SUP" | "CRE" | "COM" | "BRK" | "B2C";
}
export function prioritizeEnrichment(targets: EnrichmentTarget[]): EnrichmentTarget[] {
  const eligible=targets.filter(t=>t.officialDomain && t.existingVerifiedEmailCount===0);
  const categoryWeight: Record<EnrichmentTarget["category"],number> =
    {B2B:7,RES:6,SUP:5,BRK:4,COM:3,CRE:2,B2C:1};
  return eligible.sort((a,b)=>
    (categoryWeight[b.category]+Number(b.contactPhoneCount>0))-
    (categoryWeight[a.category]+Number(a.contactPhoneCount>0)) ||
    a.recordId.localeCompare(b.recordId)
  );
}
