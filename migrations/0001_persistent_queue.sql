-- PostgreSQL 15+; storage only, never live outreach.
CREATE TABLE import_batches (
  batch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_worker text NOT NULL CHECK (source_worker = btrim(source_worker) AND length(source_worker) BETWEEN 1 AND 200),
  source_batch text NOT NULL CHECK (source_batch = btrim(source_batch) AND length(source_batch) BETWEEN 1 AND 200),
  original_source_evidence jsonb NOT NULL CHECK (jsonb_typeof(original_source_evidence) = 'object'),
  raw_discovered_count bigint NOT NULL CHECK (raw_discovered_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_worker, source_batch),
  UNIQUE (batch_id, source_worker)
);
CREATE TABLE import_rows (
  import_row_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES import_batches(batch_id),
  row_number integer NOT NULL CHECK (row_number > 0),
  raw_record_id text,
  raw_payload jsonb NOT NULL CHECK (jsonb_typeof(raw_payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (batch_id, row_number)
);
CREATE FUNCTION reject_raw_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Raw import audit is append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER import_batches_immutable BEFORE UPDATE OR DELETE ON import_batches FOR EACH ROW EXECUTE FUNCTION reject_raw_audit_mutation();
CREATE TRIGGER import_batches_no_truncate BEFORE TRUNCATE ON import_batches FOR EACH STATEMENT EXECUTE FUNCTION reject_raw_audit_mutation();
CREATE TRIGGER import_rows_immutable BEFORE UPDATE OR DELETE ON import_rows FOR EACH ROW EXECUTE FUNCTION reject_raw_audit_mutation();
CREATE TRIGGER import_rows_no_truncate BEFORE TRUNCATE ON import_rows FOR EACH STATEMENT EXECUTE FUNCTION reject_raw_audit_mutation();

CREATE TABLE prospects (
  record_id text PRIMARY KEY CHECK (record_id = btrim(record_id) AND length(record_id) BETWEEN 1 AND 200),
  source_batch_id uuid NOT NULL,
  source_worker text NOT NULL CHECK (source_worker = btrim(source_worker) AND length(source_worker) BETWEEN 1 AND 200),
  original_source_evidence jsonb NOT NULL CHECK (jsonb_typeof(original_source_evidence) = 'object'),
  canonical_domain text CHECK (
    canonical_domain = lower(btrim(canonical_domain)) AND length(canonical_domain) <= 253
    AND canonical_domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
  ),
  normalized_company_name text CHECK (normalized_company_name = lower(btrim(normalized_company_name)) AND length(normalized_company_name) BETWEEN 1 AND 300),
  country text CHECK (country ~ '^[A-Z]{2}$'),
  region text CHECK (region = lower(btrim(region)) AND length(region) BETWEEN 1 AND 200),
  category text CHECK (category = btrim(category) AND length(category) BETWEEN 1 AND 200),
  identity_status text NOT NULL DEFAULT 'unchecked' CHECK (identity_status IN ('unchecked', 'certified', 'conflict')),
  identity_certified_at timestamptz,
  relevance_status text NOT NULL DEFAULT 'unknown' CHECK (relevance_status IN ('unknown', 'relevant', 'irrelevant')),
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified', 'verified', 'rejected', 'needs_review')),
  verification_evidence jsonb CHECK (jsonb_typeof(verification_evidence) = 'object'),
  verified_at timestamptz,
  contactability_status text NOT NULL DEFAULT 'unknown' CHECK (contactability_status IN ('unknown', 'contactable', 'uncontactable')),
  suppression_status text NOT NULL DEFAULT 'unchecked' CHECK (suppression_status IN ('unchecked', 'passed', 'suppressed')),
  suppression_checked_at timestamptz,
  suppression_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (source_batch_id, source_worker) REFERENCES import_batches(batch_id, source_worker),
  CHECK (canonical_domain IS NOT NULL OR (normalized_company_name IS NOT NULL AND country IS NOT NULL)),
  CHECK (identity_status <> 'certified' OR identity_certified_at IS NOT NULL),
  CHECK (verification_status <> 'verified' OR (verified_at IS NOT NULL AND verification_evidence IS NOT NULL AND verification_evidence <> '{}'::jsonb)),
  CHECK (suppression_status = 'unchecked' OR suppression_checked_at IS NOT NULL)
);
CREATE UNIQUE INDEX prospects_canonical_domain_unique ON prospects(canonical_domain) WHERE canonical_domain IS NOT NULL;
CREATE UNIQUE INDEX prospects_compound_identity_unique ON prospects(normalized_company_name, country, COALESCE(region, '')) WHERE normalized_company_name IS NOT NULL AND country IS NOT NULL;
CREATE INDEX prospects_source_batch ON prospects(source_batch_id);
CREATE FUNCTION preserve_prospect_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.record_id IS DISTINCT FROM OLD.record_id OR NEW.source_batch_id IS DISTINCT FROM OLD.source_batch_id
    OR NEW.source_worker IS DISTINCT FROM OLD.source_worker OR NEW.original_source_evidence IS DISTINCT FROM OLD.original_source_evidence THEN
    RAISE EXCEPTION 'Prospect record ID and original source are immutable' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER prospects_preserve_source BEFORE UPDATE ON prospects FOR EACH ROW EXECUTE FUNCTION preserve_prospect_source();

CREATE TABLE identity_conflicts (
  conflict_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_row_id uuid NOT NULL REFERENCES import_rows(import_row_id),
  existing_record_id text REFERENCES prospects(record_id),
  conflict_kind text NOT NULL CHECK (conflict_kind IN ('malformed_record_id', 'duplicate_record_id', 'domain_collision', 'compound_identity_collision')),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'resolved', 'rejected')),
  resolution_notes text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reviewed_at timestamptz,
  CHECK (review_status = 'pending' OR (reviewed_at IS NOT NULL AND nullif(btrim(resolution_notes), '') IS NOT NULL))
);
CREATE INDEX identity_conflicts_pending ON identity_conflicts(created_at) WHERE review_status = 'pending';

CREATE TABLE jobs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('ingest_batch', 'reconcile_identity', 'enrich_contact', 'verify_contact', 'suppression_check', 'prepare_outreach')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  idempotency_key text NOT NULL UNIQUE CHECK (idempotency_key = btrim(idempotency_key) AND length(idempotency_key) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'leased', 'succeeded', 'retry', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 100),
  retry_backoff_ms integer NOT NULL DEFAULT 1000 CHECK (retry_backoff_ms BETWEEN 1 AND 3600000),
  retry_max_backoff_ms integer NOT NULL DEFAULT 60000 CHECK (retry_max_backoff_ms BETWEEN 1 AND 86400000),
  scheduled_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  leased_by text CHECK (leased_by = btrim(leased_by) AND length(leased_by) BETWEEN 1 AND 200),
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  last_error text CHECK (length(last_error) <= 4000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CHECK (attempts <= max_attempts),
  CHECK (retry_max_backoff_ms >= retry_backoff_ms),
  CHECK ((status = 'queued' AND attempts = 0) OR (status = 'retry' AND attempts BETWEEN 1 AND max_attempts - 1) OR (status IN ('leased', 'succeeded', 'dead') AND attempts > 0)),
  CHECK ((status = 'leased' AND lease_token IS NOT NULL AND leased_by IS NOT NULL AND lease_expires_at IS NOT NULL AND heartbeat_at IS NOT NULL) OR (status <> 'leased' AND lease_token IS NULL AND leased_by IS NULL AND lease_expires_at IS NULL AND heartbeat_at IS NULL)),
  CHECK ((status IN ('succeeded', 'dead') AND finished_at IS NOT NULL) OR (status NOT IN ('succeeded', 'dead') AND finished_at IS NULL))
);
CREATE INDEX jobs_claimable ON jobs(available_at, created_at, job_id) WHERE status IN ('queued', 'retry');
CREATE INDEX jobs_expired_leases ON jobs(lease_expires_at, job_id) WHERE status = 'leased';
CREATE INDEX jobs_status ON jobs(status);
CREATE FUNCTION stamp_job_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.type IS DISTINCT FROM OLD.type OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
    OR NEW.retry_backoff_ms IS DISTINCT FROM OLD.retry_backoff_ms OR NEW.retry_max_backoff_ms IS DISTINCT FROM OLD.retry_max_backoff_ms
    OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Job definition and scheduling intent are immutable' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER jobs_stamp_updated_at BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION stamp_job_updated_at();
COMMENT ON TABLE import_batches IS 'Immutable raw discovery counts; not certified unique or verified-new counts.';
COMMENT ON TABLE import_rows IS 'Immutable source rows; no ingestion adapter is implemented.';
COMMENT ON TABLE identity_conflicts IS 'Manual-review storage; automatic reconciliation is not implemented.';
COMMENT ON TABLE jobs IS 'At-least-once queue; a lease fences queue writes, not external side effects.';
