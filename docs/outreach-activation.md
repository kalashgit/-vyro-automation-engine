# End-to-end acquisition and outreach activation plan

**Status: DEVELOPMENT ONLY. No live outreach enabled.**

## Objective
Sustain verified downstream throughput at least as high as the qualified lead inflow.
The 13 lead-discovery workers are a production target, not evidence that 13
verification or sending processes are currently running. The scheduler budgets
up to 13 local processing slots on the existing shared queue. Measure actual
per-stage completion rate and scale only after verifying performance.

## Pipeline contract
DISCOVERED -> IMPORTED -> LOCALLY UNIQUE -> INDEPENDENTLY VERIFIED ->
ENRICHED -> CONTACT EVIDENCE VERIFIED -> SUPPRESSION CHECKED ->
OUTREACH PREPARED -> OPERATOR APPROVED -> SENT -> REPLY HANDLED ->
FOLLOW-UP / HUMAN CLOSE.

- Existing import, reconciliation and enrichment code must be wired into an
  approved ingestion adapter with a durable import manifest and read-back.
- Local database uniqueness is not proof of VERIFIED NEW against all VYRO
  Library and previously accepted batches. Keep global reconciliation separate.
- Imported addresses are staged, not independently verified.
- Evidence-backed verification must store source, method, checked-at time,
  confidence, channel-specific consent/lawful-basis and a review trail.
- A fresh suppression decision is required again immediately before sending.
  Unsubscribe, bounced addresses, opt-out and do-not-contact always take
  precedence over old approvals.
- Preparation is NOT sending. Sending needs an explicitly enabled provider
  adapter, deliverability controls, operator approval, atomic per-recipient
  reservation, provider idempotency or reconciliation, rate limits, and
  auditable message state. Do not activate by default.
- Observe applicable Greek/EU electronic marketing and personal-data rules
  before any cold outreach. This plan does not assume every public email is
  legally contactable.
- Follow-ups must stop on reply, unsubscribe, bounce, suppression or manual pause.

## Backpressure and capacity
Track arrival and completed counts *per stage* over rolling 1h and 24h
windows; track p50/p95 time-to-ready and age of oldest eligible prospect.
Daily sustainable send capacity must be <= independently verified, legally
eligible and suppression-cleared available inventory; never fabricate volume.
Use a 13-slot capacity budget for internal processing, not 13 email accounts,
domains or unsupervised sender agents. Prioritize the smallest downstream
throughput stage using measured queue age and failures. Pause acquisition
imports if global identity review or suppression processing falls behind.
Retries use existing leases and idempotency, not duplicate sends.

## Remaining engineering gates before first live use
1. Database-backed ingest and globally reconciled VERIFIED NEW certification,
   preserving 100-record batch and assigned-folder read-back rules.
2. A verification service with evidence ledger, manual review, provider
   availability failure states, and no optimistic auto-approval.
3. Database integration for recipient-gate rules (including verification
   timestamps and recipient-level suppression), transactional preparation and
   refreshed suppression-cycle idempotency.
4. Read-only control panel: backlog by stage, conversion, worker heartbeats,
   dead-letter queue, bounce/complaint/opt-out counts; manual pause.
5. Approved outbound provider and reply/bounce/unsubscribe webhooks;
   throttling, daily caps, test mode, per-recipient dedupe and explicit rollout.
6. CI integration tests with disposable PostgreSQL, concurrency, lease-replay,
   concurrent stop/opt-out, webhook races, and end-to-end synthetic prospects.
7. Deploy independent worker/watchdog hosts and verify production readiness.
   Never start worker loops inside the Vercel request process.

## Current development branch
- `recipient-gate.ts`: pure, fail-closed eligibility rules. Not integrated
  into the database or delivery path yet.
- `acquisition-planner.ts`: deterministic next-step planning and allocation
  helper. Not yet connected to a polling scheduler.
- Tests cover both pure modules. Passing CI remains to be independently checked.
- Existing worker implementation can run 1-13 shared-queue loops, but handlers
  still cover only locally unique identity checks, staged enrichment and
  limited suppression checks. There is no live send handler.
