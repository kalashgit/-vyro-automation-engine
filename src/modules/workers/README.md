# Workers

Phase 2 Milestone 2 adds independent worker and watchdog process loops, durable
process heartbeats, lease renewal during handlers, bounded expired-lease
recovery, and graceful shutdown. Neither process starts with the web app.

The worker's handler registry is intentionally empty. It will not claim queue
jobs until handlers are explicitly registered in `scripts/worker.mjs`; no job
type currently dispatches work, sends outreach, or calls an external provider.
The watchdog only recovers expired queue leases.

Both scripts require an explicit environment opt-in and a migrated database:

```bash
WORKER_ENABLED=true npm run worker
WATCHDOG_ENABLED=true npm run watchdog
```

These commands are operator-run process entry points, not Vercel scripts. Do
not set either enable flag in Vercel. Use a restricted runtime database role,
not the schema-owner role used for migrations. Configure and deploy persistent
worker/watchdog hosts only after separate approval.
