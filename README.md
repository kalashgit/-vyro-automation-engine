# VYRO Automation Engine

VYRO's automation control plane is separate from the VYRO customer storefront.
Next.js 16, TypeScript, App Router, and the existing Phase 1 liveness endpoint remain.

## Current status: Phase 2, first milestone

The engine is **NOT OPERATIONAL**. This milestone adds PostgreSQL storage,
versioned migrations, a durable queue, atomic claims, fenced leases, heartbeats,
bounded retries, expired-lease recovery, and automated PostgreSQL tests.

The dashboard is protected by single-operator HTTP Basic authentication. It shows
real queue counts only when a migrated database is configured and reachable.
Missing database settings show **NOT CONFIGURED**; connection/schema errors show
**UNAVAILABLE**. Workers and Watchdog remain **NOT CONFIGURED**.

No ingestion adapter, enrichment/reconciliation implementation, certification
metrics, worker process, manual job-run UI, or outbound messaging is implemented.
Issue #2 remains open for its later milestones.

- `/api/health`: public HTTP liveness; preserves the Phase 1 JSON contract.
- `/`: authenticated control-plane dashboard, always **NOT OPERATIONAL** in this milestone.
- `/api/readiness`: authenticated database readiness and separate worker/watchdog
  status. It returns 503 until the independently deployed worker milestone is implemented.
- Last heartbeat remains the timestamp of this HTTP response, explicitly separate
  from the future independent worker heartbeat.

## Development

Use Node.js **22.x** and npm.

```bash
git clone https://github.com/kalashgit/-vyro-automation-engine.git
cd -- -vyro-automation-engine
nvm use
npm ci
cp .env.example .env.local
npm run dev
```

Set `ADMIN_USERNAME` and a unique `ADMIN_PASSWORD` of at least 16 characters in
`.env.local`. Open http://localhost:3000 and enter those credentials.
Missing or invalid admin configuration fails closed with HTTP 503. Wrong or absent
credentials return HTTP 401. The liveness endpoint remains public without any settings.
Basic authentication requires HTTPS outside local development; Vercel provides HTTPS.

## PostgreSQL and migrations

Use PostgreSQL **15 or newer** (CI uses PostgreSQL 16). Configure `DATABASE_URL`.
Certificate verification is enabled by default. Use `DATABASE_SSL_CA` for a
custom trusted CA if required. `DATABASE_SSL_MODE=disable` is accepted only for
loopback development/CI. Put SSL settings in these variables, not URL query parameters.

Run migrations as an explicit deployment step with a migration role and a direct
or session-pooled connection. Transaction poolers do not preserve session advisory
locks; use a direct connection URL for the migration command.

```bash
npm run db:migrate
```

The CLI reads environment variables from the shell or Node's explicit
`--env-file` option; it does not load Next.js `.env.local` automatically. To use
a local environment file:

```bash
node --env-file=.env.local --experimental-strip-types scripts/migrate.mjs
```

Migrations serialize under a PostgreSQL advisory lock, apply transactionally,
record SHA-256 checksums, and reject changes to previously applied SQL. There is
no automatic startup migration or destructive down command. See
[queue and database design](docs/persistent-queue.md) for deployment details.

## Checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:smoke
npm start
```

`npm test` requires `TEST_DATABASE_URL` pointing to a **local disposable**
PostgreSQL database whose name ends in `_test`. It refuses missing/unsafe targets,
uses random isolated schemas, cleans them up, and never falls back to `DATABASE_URL`.
Tests exercise actual SQL concurrency and locks, not a mocked queue.

The smoke script starts the production server with temporary synthetic admin
credentials and no database connection. It tests fail-closed configuration,
authentication, the dashboard, fresh public liveness, not-ready status, security
headers, and 404 behavior. No fixtures are imported into a production database.

GitHub Actions provisions PostgreSQL 16 and runs installation, production dependency
audit, lint, TypeScript, database/queue/auth tests, build, and HTTP smoke checks.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ADMIN_USERNAME` | Single-operator dashboard/API login; no colon permitted |
| `ADMIN_PASSWORD` | Unique server-side password, at least 16 characters |
| `DATABASE_URL` | PostgreSQL connection string |
| `DATABASE_SSL_MODE` | `verify-full` (default), or local-only `disable` |
| `DATABASE_SSL_CA` | Optional trusted CA PEM |
| `TEST_DATABASE_URL` | Local disposable test database ending in `_test` |
| `API_BASE_URL`, `API_KEY` | Reserved future integrations; unused |

Environment files are ignored except `.env.example`. Never commit real
credentials or expose them through `NEXT_PUBLIC_*`, API responses, or logs.
The current auth model is one operator and one database, with no multi-tenant
claims. Add appropriate identity/tenant isolation before supporting multiple operators
or tenants. No public endpoint can enqueue jobs or read prospect PII.

## Vercel and independent workers

Vercel hosts the Next.js dashboard and API only. Use Node.js 22.x,
`npm ci`, `npm run build`, and the default Next.js output directory.
Set admin credentials in the deployment environment; without them the dashboard
deliberately returns 503. Set the database variables only after provisioning
PostgreSQL and applying migrations.

Required deployment work is separate from this PR: provision PostgreSQL, run
migrations, verify protected DB readiness, then implement/deploy/test a persistent
independent Node worker and watchdog in the next milestone. No continuous worker
runs inside a Vercel request handler. A successful Vercel web deployment does not
mean the automation engine is operating.

## Structure

```text
migrations/                   Versioned PostgreSQL SQL
src/app/                      Preserved App Router UI and API routes
src/proxy.ts                  Admin route protection
src/config/                   Server-only future API configuration
src/lib/                      Auth and liveness
src/modules/database/         Typed pool and migration runner
src/modules/queue/            Durable queue and typed lifecycle contracts
src/modules/monitoring/       Read-only database and queue status
src/modules/{workers,enrichment,outreach,alerts}/
                              Future modules, not operational
tests/                        Isolated PostgreSQL and auth fixtures
scripts/                      Migration CLI and production HTTP smoke tests
.github/workflows/            PostgreSQL/application CI
```

Future workflow remains unimplemented:

VERIFIED PROSPECTS → ENRICHMENT → CONTACTABLE → SUPPRESSION CHECK →
OUTREACH READY → QUEUED → CONTACTED → FOLLOW-UP → REPLIED → INTERESTED →
HUMAN CLOSE → CUSTOMER.
