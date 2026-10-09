-- Public account evidence is distinct from verified contact/recipient approval.
ALTER TABLE prospects ADD COLUMN canonical_profile_url text CHECK (canonical_profile_url LIKE 'https://%');
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='prospects'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%canonical_domain IS NOT NULL%normalized_company_name IS NOT NULL%'
  LOOP EXECUTE format('ALTER TABLE prospects DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE prospects ADD CONSTRAINT prospects_identity_present CHECK (
  canonical_domain IS NOT NULL OR canonical_profile_url IS NOT NULL OR (normalized_company_name IS NOT NULL AND country IS NOT NULL));
CREATE UNIQUE INDEX prospects_profile_unique ON prospects(canonical_profile_url) WHERE canonical_profile_url IS NOT NULL;
DROP INDEX prospects_compound_identity_unique;
CREATE UNIQUE INDEX prospects_compound_identity_unique ON prospects(normalized_company_name,country,COALESCE(region,''))
  WHERE normalized_company_name IS NOT NULL AND country IS NOT NULL AND canonical_profile_url IS NULL;
ALTER TABLE identity_conflicts DROP CONSTRAINT identity_conflicts_conflict_kind_check;
ALTER TABLE identity_conflicts ADD CONSTRAINT identity_conflicts_conflict_kind_check CHECK (
  conflict_kind IN ('malformed_record_id','duplicate_record_id','domain_collision','compound_identity_collision','profile_collision'));
CREATE TABLE import_profile_routes (
  import_row_id uuid NOT NULL REFERENCES import_rows(import_row_id), record_id text,
  canonical_url text NOT NULL, platform text NOT NULL, handle text NOT NULL,
  PRIMARY KEY(import_row_id,canonical_url)
);
CREATE INDEX import_profile_routes_url ON import_profile_routes(canonical_url);
CREATE TABLE profile_indexed_rows (import_row_id uuid PRIMARY KEY REFERENCES import_rows(import_row_id));
CREATE TABLE social_enrichment_runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL UNIQUE REFERENCES jobs(job_id),
  record_id text NOT NULL REFERENCES prospects(record_id),
  outcome text NOT NULL CHECK(outcome IN ('profiles_found','no_profiles','needs_review')),
  notes text[] NOT NULL DEFAULT '{}', completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(run_id,record_id)
);
CREATE INDEX social_enrichment_runs_record ON social_enrichment_runs(record_id,completed_at DESC);
CREATE TABLE social_profile_evidence (
  evidence_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL, record_id text NOT NULL,
  canonical_url text NOT NULL CHECK(canonical_url LIKE 'https://%'), platform text NOT NULL, handle text NOT NULL,
  source_url text NOT NULL CHECK(source_url LIKE 'https://%' OR source_url LIKE 'http://%'),
  relationship text NOT NULL CHECK(relationship IN ('supplied_profile','website_link')),
  source_details text NOT NULL CHECK(length(source_details)<=2000),
  duplicate_record_ids text[] NOT NULL DEFAULT '{}', observed_at timestamptz NOT NULL,
  review_status text NOT NULL DEFAULT 'pending' CHECK(review_status='pending'),
  account_availability text NOT NULL DEFAULT 'unknown' CHECK(account_availability='unknown'),
  dm_availability text NOT NULL DEFAULT 'unknown' CHECK(dm_availability='unknown'),
  FOREIGN KEY(run_id,record_id) REFERENCES social_enrichment_runs(run_id,record_id),
  UNIQUE(run_id,canonical_url,source_url,relationship)
);
CREATE INDEX social_profile_evidence_url ON social_profile_evidence(canonical_url);
CREATE TRIGGER social_runs_immutable BEFORE UPDATE OR DELETE ON social_enrichment_runs FOR EACH ROW EXECUTE FUNCTION reject_raw_audit_mutation();
CREATE TRIGGER social_evidence_immutable BEFORE UPDATE OR DELETE ON social_profile_evidence FOR EACH ROW EXECUTE FUNCTION reject_raw_audit_mutation();
CREATE TRIGGER social_runs_no_truncate BEFORE TRUNCATE ON social_enrichment_runs FOR EACH STATEMENT EXECUTE FUNCTION reject_raw_audit_mutation();
CREATE TRIGGER social_evidence_no_truncate BEFORE TRUNCATE ON social_profile_evidence FOR EACH STATEMENT EXECUTE FUNCTION reject_raw_audit_mutation();
