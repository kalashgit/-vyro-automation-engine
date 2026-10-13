import type { Pool } from 'pg';
export async function getEnrichmentResults(pool:Pool,offset=0,limit=50) {
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('Invalid pagination.');
 const {rows}=await pool.query(`SELECT p.record_id,p.category,p.normalized_company_name,r.outcome,r.notes,r.completed_at,
   e.outcome AS website_outcome,e.reason AS website_reason,e.completed_at AS website_completed_at,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('url',e.canonical_url,'platform',e.platform,'source',e.source_url,
     'relationship',e.relationship,'duplicates',e.duplicate_record_ids,'observedAt',e.observed_at,'reviewStatus',e.review_status)
     ORDER BY e.platform,e.canonical_url) FROM social_profile_evidence e WHERE e.run_id=r.run_id),'[]'::jsonb) AS profiles
   ,COALESCE((SELECT jsonb_agg(jsonb_build_object('email',c.email_normalized,'sourceUrl',ep.source_url,
     'decision',c.identity_decision,'duplicates',c.duplicate_record_ids,'suppressed',c.suppressed,
     'excerpt',c.evidence_excerpt,'reviewStatus',c.review_status)
     ORDER BY c.email_normalized,ep.source_url) FROM enrichment_candidates c
     JOIN enrichment_pages ep ON ep.page_id=c.page_id AND ep.run_id=c.run_id WHERE c.run_id=e.run_id),'[]'::jsonb) AS emails
   FROM prospects p LEFT JOIN LATERAL(SELECT * FROM social_enrichment_runs WHERE record_id=p.record_id ORDER BY completed_at DESC,run_id DESC LIMIT 1)r ON true
   LEFT JOIN LATERAL(SELECT * FROM enrichment_runs WHERE record_id=p.record_id ORDER BY completed_at DESC,run_id DESC LIMIT 1)e ON true
   ORDER BY p.created_at,p.record_id OFFSET $1 LIMIT $2`,[offset,limit]);
 const {rows:[counts]}=await pool.query(`SELECT (SELECT count(*)::int FROM prospects) AS prospects,
   (SELECT count(DISTINCT record_id)::int FROM social_enrichment_runs) AS social_processed,
   (SELECT count(DISTINCT record_id)::int FROM social_enrichment_runs) AS processed,
   (SELECT count(DISTINCT record_id)::int FROM social_profile_evidence) AS social_with_profiles,
   (SELECT count(DISTINCT record_id)::int FROM social_profile_evidence) AS with_profiles,
   (SELECT count(DISTINCT record_id)::int FROM enrichment_runs) AS website_processed,
   (SELECT count(DISTINCT record_id)::int FROM enrichment_candidates) AS website_with_candidates,
   (SELECT count(*)::int FROM jobs WHERE type='enrich_contact' AND status IN ('queued','leased','retry')) AS pending,
   (SELECT count(*)::int FROM jobs WHERE type='enrich_contact' AND status='dead') AS failed`);
 return {counts,prospects:rows,offset,limit};
}
