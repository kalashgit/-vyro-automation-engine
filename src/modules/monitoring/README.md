# Monitoring

Readiness reports whether worker and watchdog process heartbeats are current.
No recent process record is `not_configured`; a recorded but stale or stopped
process is `unavailable`. Heartbeats indicate process liveness only, not that
handlers are registered, jobs are progressing, or outreach is operational.
