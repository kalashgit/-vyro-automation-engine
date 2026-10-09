-- Daily outbound reservation ledger: no delivery action is implemented here.
-- Lease-expired/ambiguous provider attempts must remain counted until reconciled.
CREATE TABLE IF NOT EXISTS outbound_reservations (
 reservation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 record_id text NOT NULL,
 email_normalized text NOT NULL CHECK (email_normalized=lower(btrim(email_normalized))),
 campaign_key text NOT NULL CHECK (length(campaign_key) BETWEEN 3 AND 100),
 utc_day date NOT NULL,
 status text NOT NULL DEFAULT 'reserved'
   CHECK (status IN ('reserved','sending','sent','failed_before_send','delivery_unknown','cancelled')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 provider_message_id text,
 UNIQUE (email_normalized,campaign_key),
 CHECK ((status <> 'sent') OR provider_message_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS outbound_quota_idx ON outbound_reservations(utc_day,status);
