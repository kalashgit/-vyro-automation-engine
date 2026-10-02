CREATE TABLE IF NOT EXISTS email_suppressions (
 email_normalized TEXT PRIMARY KEY,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
