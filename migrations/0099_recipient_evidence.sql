-- Independent evidence and operator approval; imported contacts never auto-verify.
-- Version 0099 intentionally reserved to avoid modifying any previously applied migration.
CREATE TABLE IF NOT EXISTS recipient_verification_evidence (
  evidence_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id text NOT NULL,
  email_normalized text NOT NULL CHECK (length(email_normalized) BETWEEN 3 AND 254 AND email_normalized = lower(btrim(email_normalized))),
  source_url text NOT NULL CHECK (source_url ~ '^https://'),
  method text NOT NULL CHECK (method IN ('confirmed_business_page', 'confirmed_correspondence', 'provider_verified', 'manual_review')),
  evidence_note text NOT NULL CHECK (length(btrim(evidence_note)) BETWEEN 8 AND 2000),
  reviewed_by text NOT NULL CHECK (length(btrim(reviewed_by)) BETWEEN 2 AND 200),
  evidence_checked_at timestamptz NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (record_id, email_normalized, source_url, method, evidence_checked_at),
  CHECK (evidence_checked_at <= approved_at)
);
CREATE INDEX IF NOT EXISTS recipient_evidence_active_idx
  ON recipient_verification_evidence (record_id, email_normalized, approved_at DESC)
  WHERE revoked_at IS NULL;

-- Auditable preparation only. No provider delivery, send attempt, or automatic approval.
CREATE TABLE IF NOT EXISTS outreach_preparations (
  preparation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id text NOT NULL,
  email_normalized text NOT NULL CHECK (email_normalized = lower(btrim(email_normalized))),
  verification_evidence_id uuid NOT NULL REFERENCES recipient_verification_evidence(evidence_id),
  status text NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'approved', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reviewed_at timestamptz,
  reviewed_by text,
  UNIQUE (record_id,email_normalized)
);
