# Persistent queue: first milestone

This milestone implements storage and queue lifecycle primitives for Issue #2.
It does not import Library ledgers, perform enrichment, send messages, run
continuous workers, certify VERIFIED NEW prospects, or count toward the 1,000 goal.

## Database ownership and integrity

Use a dedicated PostgreSQL database and schema. Run migrations with a schema-owner
role during deployment, then connect the application/worker using a restricted
runtime role. Store passwords and CA material in the host's environment manager.

- `import_batches` stores immutable original discovery evidence and raw discovery
  counts. These counts are not globally unique or certified VERIFIED NEW.
- `import_rows` retains append-only source rows, including raw malformed IDs.
- `prospects` has an immutable record ID and original provenance, normalized
  domain and compound identity uniqueness constraints, verification evidence,
  relevance/contactability/suppression state, and timestamps.
- `identity_conflicts` reserves manual-review records. Uniqueness errors must
  be quarantined for later review rather than silently merged.
- `jobs` persists typed payloads, idempotency, scheduling intent, state, attempt
  limits, retry policy, lease owner/token/expiry, heartbeat, and terminal/error data.

The ingestion adapter and collision-review UI belong to later milestones.
Database uniqueness rejects conflicting writes; this milestone does not
automatically reconcile or certify identities. Suppression and verified-new
counting behavior have not been implemented.

Migrations are versioned SQL files. A checksum ledger rejects edited applied
migrations; create a new migration instead. Each migration and ledger entry commit
together, and failed SQL rolls back. An advisory lock serializes concurrent runners. Use a direct or session-pooled
migration connection, not a transaction pooler that changes the underlying session.
Keep backups and restore procedures outside this repository; no down migration
silently destroys imported audit data.

## Queue contract

Allowed job types are `ingest_batch`, `reconcile_identity`, `enrich_contact`,
`verify_contact`, `suppression_check`, and `prepare_outreach`. They are typed job
labels only; no executable dispatchers or outbound handlers exist.

The queue lifecycle is:

```text
queued / retry → leased → succeeded
                      ↘ retry → leased
                      ↘ dead
expired leased → retry / dead
```

Claims use PostgreSQL row locks with `FOR UPDATE SKIP LOCKED` in a single
transactional statement. Independent clients can claim different eligible jobs
without waiting for each other's locked rows. Attempts increment on claim.
Future-dated jobs remain unavailable until PostgreSQL's clock reaches their due time.

Each claim issues a new random lease token. Renewal, completion, and failure
require the current token, worker ID, leased state, and an unexpired lease measured
by the database clock. Stale owners cannot renew or acknowledge a reclaimed job.
Lease heartbeat data is persisted per job; it is not an independent worker's
liveness registry.

Retry delays use persisted exponential backoff capped by the job policy.
Failure and expired-lease recovery both respect the maximum attempt limit.
Exhausted jobs become `dead` with terminal timestamps. Recovery is explicit,
bounded, and safe under concurrency; the later worker/watchdog must call it.
Nothing runs automatically in the web server.

Enqueue is idempotent for matching type, payload, scheduling intent, and retry
settings. Reusing an idempotency key for different intent raises a conflict.
Keep idempotency keys stable for logical work rather than generating a new key
for every retry.

## Delivery semantics

This is an **at-least-once** queue. A crash after an external side effect and
before acknowledgement can cause replay. Lease fencing protects queue state;
it cannot revoke an external action that an expired worker already started.
Future integrations must use stable idempotency keys, suppression precedence,
duplicate-contact protection, and appropriate provider/transaction controls
before any real outbound messaging is approved.

There are no queue mutation HTTP endpoints. Admin authentication protects the
dashboard and non-liveness API routes, and readiness rechecks authorization.
Do not add public enqueue routes or return prospect payloads/error details to
unauthenticated users.

## Deployment boundary

The current engine status is always NOT OPERATIONAL. Database readiness and
worker readiness are reported separately. Queue depth is a database observation,
not proof that jobs are being executed.

Provision PostgreSQL with TLS, run migrations explicitly, configure the web
deployment, and verify authenticated readiness/database observations.
Then build/deploy/test an independent persistent worker in the next milestone,
including graceful shutdown, lease renewal, retry scheduling, recovery, and a
worker heartbeat registry. Vercel hosts only the control plane.

The test PostgreSQL service and synthetic fixtures exist only in disposable CI
or local `_test` databases; they are not a production deployment or live prospects.
