# Engine modules

Database and queue primitives are implemented for the first milestone of Issue #2.
Workers, enrichment, outreach, monitoring, and alerts remain future modules.
No jobs run automatically and no outbound messaging is implemented.

Future execution must preserve atomic claims, fenced leases, idempotency, bounded
retries, durable heartbeats, recovery, suppression and duplicate-contact protection,
and independent watchdog monitoring. See [design](../../docs/persistent-queue.md).
