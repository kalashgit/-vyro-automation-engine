-- Durable recipient-level suppression; apply before enabling promotional email.
CREATE TABLE IF NOT EXISTS email_suppressions (
 email TEXT PRIMARY KEY,
 reason TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT email_suppressions_normalized CHECK (email=lower(trim(email)))
);
