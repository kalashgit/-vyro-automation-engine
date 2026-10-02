# VYRO Automation Engine

The VYRO Automation Engine is the automation control plane for VYRO operations.
It is separate from the VYRO customer storefront.

## Phase 1 status

This repository contains the application foundation: a Next.js 16 App Router
application with TypeScript, ESLint, a minimal dashboard, a health endpoint,
server-only environment handling, and CI. No automation workflow is implemented.

- `/` shows **Engine Status: ONLINE** when the web application responds.
- Queue Status, Workers, and Watchdog show **NOT CONFIGURED**.
- Last heartbeat is the timestamp of the current HTTP response, not a persisted
  worker heartbeat. Reload the page to obtain a new timestamp.
- `/api/health` reports HTTP liveness only. It does not prove database,
  queue, worker, watchdog, or external API readiness.

No database, API key, paid service, or environment variable is required for Phase 1.

## Local development

Use Node.js **22.x** and npm. `.nvmrc` and `package.json` specify the Node version.

```bash
git clone https://github.com/kalashgit/-vyro-automation-engine.git
cd -- -vyro-automation-engine
nvm use
npm install
cp .env.example .env.local
npm run dev
```

Open http://localhost:3000. Copying the environment example is optional in Phase 1.
The committed lockfile supports reproducible installs using `npm ci`.

## Checks and production build

```bash
npm run lint
npm run typecheck
npm run build
npm run test:smoke
npm start
```

`typecheck` generates Next.js route types before running `tsc --noEmit`.
The smoke check starts `npm start` on an available local port, verifies the dashboard,
health JSON and fresh timestamps, security headers, and a 404 response, then stops
the server. Build the application before running it. It uses Node built-ins only.

The GitHub Actions workflow repeats installation, lint, type checking, production
build, and HTTP smoke verification on pushes to `main` and pull requests.

To inspect health while the application is running:

```bash
curl http://localhost:3000/api/health
```

The endpoint returns HTTP 200 with `Cache-Control: no-store` and JSON of this shape:

```json
{
  "status": "ok",
  "service": "vyro-automation-engine",
  "timestamp": "2026-10-02T12:00:00.000Z",
  "version": "0.1.0"
}
```

The version comes from `package.json`; timestamps are generated per request.

## Environment variables

Keep local values in `.env.local`. Environment files are ignored by Git except
`.env.example`. Configure deployment values in Vercel project settings.

`src/config/env.ts` is protected by `server-only` and provides `getServerEnv()`
for future server-side integration code. It treats unset or blank values as absent
and validates supplied URL values when called, without printing their contents.

| Variable | Purpose | Required in Phase 1 |
| --- | --- | --- |
| `DATABASE_URL` | Future database connection URL | No |
| `API_BASE_URL` | Future HTTP API base URL | No |
| `API_KEY` | Future server-side API credential | No |

No integration is connected yet. Never put secrets in `NEXT_PUBLIC_*` variables,
client components, API responses, or logs.

## Vercel deployment

1. Import `kalashgit/-vyro-automation-engine` into Vercel.
2. Select **Next.js** as the framework and use the repository root.
3. Use Node.js **22.x**, install command `npm ci`, and build command
   `npm run build`. Leave the output directory at its framework default.
4. Deploy, then open `/` and `/api/health`.

`vercel.json` declares the framework and commands, and `package.json` declares
the Node runtime. Phase 1 requires no deployment environment variables.
No Vercel project IDs or credentials are committed.

Next.js supplies the dynamic server routes; do not change this app to a static
export. The production build checks application compatibility, while a live Vercel
deployment still requires importing the repository into your Vercel account.

This scaffold has no privileged operational actions or prospect data. Add access
control before introducing those features.

## Project structure

```text
src/
  app/                  App Router dashboard, layout, and HTTP routes
    api/health/         Uncached health endpoint
  config/               Server-only environment handling
  lib/                  Shared service helpers
  types/                Shared TypeScript contracts
  modules/
    queue/
    workers/
    enrichment/
    outreach/
    monitoring/
    alerts/
    database/
scripts/                Production HTTP smoke verification
.github/workflows/      CI checks
```

Module directories contain documentation only. No clients, queue processors,
outreach handlers, locks, schedulers, or watchdog loops are started.

## Future workflow — intentionally not implemented

VERIFIED PROSPECTS → ENRICHMENT → CONTACTABLE → SUPPRESSION CHECK →
OUTREACH READY → QUEUED → CONTACTED → FOLLOW-UP → REPLIED → INTERESTED →
HUMAN CLOSE → CUSTOMER

Future workers must use atomic queue claiming, leases/locks, idempotency, retries,
durable heartbeats, dead-job recovery, duplicate-contact protection, and watchdog
monitoring. Design long-running workers on an appropriate durable execution
runtime; deploying this Next.js control plane to Vercel does not start a continuous
worker process.
