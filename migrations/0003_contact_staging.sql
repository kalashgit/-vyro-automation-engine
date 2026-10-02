-- Staged public contact fields; ingestion does not independently verify ownership.
CREATE TABLE contact_points (
  contact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id text NOT NULL REFERENCES prospects(record_id),
  channel text NOT NULL CHECK (channel IN ('email','phone','whatsapp','instagram','facebook','linkedin','website')),
  value text NOT NULL CHECK (value=btrim(value) AND length(value) BETWEEN 1 AND 2048),
  source_url text NOT NULL CHECK (source_url=btrim(source_url) AND length(source_url) BETWEEN 1 AND 2048),
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','verified','rejected')),
  verification_method text,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(record_id,channel,value),
  CHECK (verification_status <> 'verified' OR (verification_method IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE INDEX contact_points_review ON contact_points(record_id) WHERE verification_status='unverified';
