ALTER TABLE social_profile_evidence DROP CONSTRAINT social_profile_evidence_relationship_check;
ALTER TABLE social_profile_evidence ADD CONSTRAINT social_profile_evidence_relationship_check
  CHECK(relationship IN ('supplied_profile','website_link','search_candidate'));
CREATE TABLE enrichment_search_requests (
 job_id uuid PRIMARY KEY REFERENCES jobs(job_id),
 query_hash text NOT NULL CHECK(query_hash ~ '^[a-f0-9]{64}$'),
 budget_day date NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'Europe/Athens')::date,
 status text NOT NULL CHECK(status IN ('reserved','complete','unknown')),
 results jsonb CHECK(results IS NULL OR jsonb_typeof(results)='array'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX enrichment_search_day ON enrichment_search_requests(budget_day);
CREATE INDEX enrichment_search_query ON enrichment_search_requests(query_hash,created_at DESC);
