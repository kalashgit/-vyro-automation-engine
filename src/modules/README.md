# Future engine modules

These directories establish boundaries only. Phase 1 does not execute jobs,
connect a database, send outreach, or start any workers.

Future implementations must use atomic queue claims, leases/locks, idempotency,
bounded retries, durable heartbeats, dead-job recovery, duplicate-contact
protection, suppression checks, and watchdog monitoring.

Shared server configuration lives in `src/config`, reusable service helpers
in `src/lib`, and shared TypeScript contracts in `src/types`.
