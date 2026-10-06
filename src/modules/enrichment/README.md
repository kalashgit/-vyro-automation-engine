# Enrichment

The `official_site` enrichment mode connects existing PostgreSQL prospects to
bounded official-site collection, identity checks, evidence storage, and staged
contact points. It preserves record IDs and the original import audit.

## Run

1. Configure PostgreSQL using `.env.example`; run `npm run db:migrate` explicitly.
   Migration `0101` is additive; previously applied migrations are unchanged.
2. Preview: `node --experimental-strip-types scripts/enrich-contacts.mjs --campaign 20261006 --limit 25`.
3. Add `--apply` to enqueue the selected records. Campaign + record ID makes
   repeated enqueueing idempotent. For an explicit reviewed retry, use
   `--record-id B2B-...` and a new campaign label.
4. Run `WORKER_ENABLED=true ACQUISITION_HANDLERS_ENABLED=true ENRICHMENT_ENABLED=true npm run worker`.
   Keep `WORKER_CONCURRENCY=1` for collection initially.

Environment variables must be provided by the process environment (these Node
scripts do not automatically load `.env` files). No migration runs on startup.
The selector requires previously reconciled identities, excludes pending
identity conflicts and blocked records, prioritizes B2B/phone records, excludes
existing emails and active jobs, and avoids repeating a completed run for seven
days. A missing domain can be submitted explicitly and is recorded for review.
Domain discovery for telephone-only records without a known website remains a
separate research step; the collector never guesses an official site.

## What is stored

`enrichment_runs` records one outcome per queue job: `candidates_found`,
`no_candidates`, or `needs_review` with a reason. `enrichment_pages` records final
HTTPS URLs, SHA-256 content fingerprints and retrieval times.
`enrichment_candidates` keeps email evidence excerpts, identity decisions,
duplicate record IDs, suppression matches, and a pending review status.
Full HTML is not retained. Source identity snapshots and the immutable import
remain available alongside the evidence.

Only identity-substantiated, non-suppressed candidates without another record's
email association are added to `contact_points`, always **unverified**. Publicly
listed means observed on a page; it does not mean delivery-verified, approved,
or eligible for outreach. Ambiguous and duplicate candidates remain reviewable.
No recipient approval, prospect verification, suppression clearance, downstream
outreach job, or email is created by this pipeline. Review uses the separate
explicit recipient evidence workflow.

## Recovery and boundaries

Page fetching happens outside a database transaction. The commit transaction
checks the current queue lease and prospect identity, then stores the run, pages,
candidates and contacts atomically. A crash after commit replays without another
fetch. A crash before commit leaves no partial result. Sorted email advisory
locks serialize enrichment workers' cross-record collision checks. Duplicate
checks cover staged contacts, enrichment candidates and original imported email
fields (including multiple addresses and records not yet staged); contacts
written by older ingestion paths are retained and flagged, never merged or
deleted. Existing contact verification and provenance are never overwritten.

Transient failures use queue retries/backoff. Permanent source restrictions
produce `needs_review`; they are not counted as successfully enriched contacts.
Dead jobs retain their queue failure code. Evidence observations are immutable.

Collection supports public IPv4 HTTPS websites with standard certificates, a
maximum of three content pages, one MB per page, ten seconds per request and
45 seconds per job collection. DNS is validated and pinned to the TLS socket;
redirects remain on the exact normalized domain. It does not execute JavaScript,
follow foreign domains, use credentials, visit arbitrary ports, or infer emails.
Robots handling conservatively honors all Disallow rules and ignores Allow
overrides. Unsupported content, IPv6-only sites and inaccessible robots files
are deferred. Requests are sequential with at least one-second page spacing;
robots crawl delays up to ten seconds increase spacing, and longer or malformed
delays defer the site. DNS waiting observes the collection cancellation deadline. Keep one
collector worker; a shared cross-process request-rate budget is not implemented.

## Read back

```sql
SELECT r.record_id, r.outcome, r.reason, r.completed_at,
       count(c.candidate_id) AS candidates,
       count(c.candidate_id) FILTER (WHERE c.identity_decision='substantiated'
         AND NOT c.suppressed AND cardinality(c.duplicate_record_ids)=0) AS substantiated
FROM enrichment_runs r LEFT JOIN enrichment_candidates c USING(run_id,record_id)
GROUP BY r.run_id ORDER BY r.completed_at DESC;
```

Tests in `enrichment.integration.test.ts` use a disposable local PostgreSQL
database and deterministic page fixtures: queue dispatch, replay, collisions,
suppression, no-result outcomes, failure rollback, cancellation, lease fencing,
and the boundary between enrichment and approval. CI runs PostgreSQL 16.
