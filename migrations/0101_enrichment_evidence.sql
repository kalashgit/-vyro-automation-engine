-- Enrichment is evidence collection, never recipient approval or delivery verification.
CREATE TABLE enrichment_runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(job_id),
  record_id text NOT NULL REFERENCES prospects(record_id),
  outcome text NOT NULL CHECK (outcome IN ('candidates_found','no_candidates','needs_review')),
  reason text,
  identity_snapshot jsonb NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(run_id, record_id)
);
CREATE TABLE enrichment_pages (
  page_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES enrichment_runs(run_id),
  source_url text NOT NULL CHECK (source_url LIKE 'https://%'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  fetched_at timestamptz NOT NULL,
  UNIQUE(run_id, source_url),
  UNIQUE(page_id, run_id)
);
CREATE TABLE enrichment_candidates (
  candidate_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  record_id text NOT NULL,
  page_id uuid NOT NULL,
  email_normalized text NOT NULL CHECK (email_normalized=lower(btrim(email_normalized)) AND length(email_normalized) BETWEEN 3 AND 254),
  evidence_excerpt text NOT NULL CHECK (length(evidence_excerpt)<=4000),
  identity_decision text NOT NULL CHECK (identity_decision IN ('substantiated','unresolved')),
  evidence_details jsonb NOT NULL,
  duplicate_record_ids text[] NOT NULL DEFAULT '{}',
  suppressed boolean NOT NULL,
  publicly_listed boolean NOT NULL DEFAULT true CHECK (publicly_listed),
  delivery_verified boolean NOT NULL DEFAULT false CHECK (NOT delivery_verified),
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status='pending'),
  FOREIGN KEY (run_id,record_id) REFERENCES enrichment_runs(run_id,record_id),
  FOREIGN KEY (page_id,run_id) REFERENCES enrichment_pages(page_id,run_id),
  UNIQUE(run_id,page_id,email_normalized)
);
CREATE INDEX enrichment_candidates_email ON enrichment_candidates(email_normalized);
CREATE INDEX enrichment_runs_record ON enrichment_runs(record_id,completed_at DESC);
CREATE INDEX contact_points_normalized_email ON contact_points(lower(btrim(value))) WHERE channel='email';
-- Keep original observations immutable; approval remains a separate, explicit workflow.
CREATE TRIGGER enrichment_runs_immutable BEFORE UPDATE OR DELETE ON enrichment_runs FOR EACH ROW EXECUTE FUNCTION reject_raw_audit_mutation();
CREATE TRIGGER enrichment_pages_immutable BEFORE UPDATE OR DELETE ON enrichment_pages FOR EACH ROW EXECUTE FUNCTION reject_raw_audit_mutation();
CREATE TRIGGER enrichment_candidates_immutable BEFORE UPDATE OR DELETE ON enrichment_candidates FOR EACH ROW EXECUTE FUNCTION reject_raw_audit_mutation();
