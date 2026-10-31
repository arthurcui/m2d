# M0 — Runnable Foundation

## Delivered scope and boundaries

Three processes share a strict TypeScript pnpm workspace: `apps/web` (Next.js), `apps/api` (Fastify), and `apps/worker` (pg-boss). `packages/domain` owns Zod boundary contracts; `packages/config` owns validated server configuration; `packages/db` owns Drizzle schema, migrations, and repository methods. Only repositories touch application tables. No portfolio or inference features are implemented.

The supplied design pack remains the target architecture. Future increments remain M1 portfolio/projections/import confirmation; M2 `packages/llm` provider contracts/adapters and `packages/agent` orchestration plus analysis modes; M3 market/valuation; M4 research/evidence; M5 risk/planning; M6 monitoring/signals; M7 performance; M8 portability/hardening. There are no empty provider adapters or premature finance engines.

`packages/llm` in M2 must preserve canonical history and opaque provider/model/version-scoped continuation; SDKs and keys stay inside server-side adapters. The agent owns tools and budgets. No M0 dependency imports an inference SDK or reads an API key. `OPENAI_API_KEY` is reserved and blank in the example, passed only to backend containers. Selecting OpenAI/Gemini/Anthropic reports unavailable, never falls back. Fixture mode means operational demonstration only, not a completed analysis or a `NO_SIGNAL` investment conclusion.

## Specification resolutions and assumptions

- The milestone says `/health`; startup instructions require `/health/live` and `/health/ready`. All three exist, with `/api/v1` aliases. Application status uses `/api/v1/system/status`, consistent with the HTTP contract's global prefix.
- Operations calls for four services and a single migration owner. API's container entrypoint runs a distinct Drizzle migration command before starting Fastify. A PostgreSQL advisory lock serializes competing invocations. Worker and web wait for API readiness. This avoids a fifth permanent service and never runs migrations from web or worker.
- API readiness checks application tables, not optional AI or worker availability. Worker and scheduler health are separate status fields, allowing diagnosis when the worker stops. Heartbeat is stale after 45 seconds; last successful demo job is stale after 180 seconds. Future timestamps are not fresh. The status observation timestamp is not a market quote timestamp.
- The worker is a single local process. Its singleton heartbeat row is current operational state; completed demo jobs are append-only historical records keyed by queue UUID. SQL constraints enforce the job version and queue. Repeating a job's persistence step after an acknowledgement failure is a no-op.
- A persisted cron schedule runs every minute in UTC, independently of exchange hours. Repeated startup upserts the same schedule. The immediate startup probe is throttled within a minute, but each later process startup can intentionally create a new probe. Offline intervals are not fabricated or backfilled. Historical timestamps expose the gap.
- Full design UI libraries, charts, financial calculations, and decimal.js arithmetic are deferred until their features need them. M0 uses plain CSS and signed decimal-string contracts; it performs no financial arithmetic. No sample market prices or balances are shown.
- Reserved upload/research/export/backup directories are bind mounted but unused by M0. There is no file upload API or automated backup job yet. No authentication or remote exposure is added.

## HTTP contracts

All responses include version 1 metadata where returned by Fastify. Operational metadata has UTC `asOf`, source `m2d-system`, and quality `OPERATIONAL`.

| Route                                                           | Behavior                                                                     |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /health/live`                                              | 200 while API can serve requests, independent of database                    |
| `GET /health`, `GET /health/ready`                              | 200 if application tables are queryable; otherwise 503 `DATABASE_NOT_READY`  |
| `/api/v1/health`, `/api/v1/health/live`, `/api/v1/health/ready` | Versioned aliases, reachable through web                                     |
| `GET /api/v1/system/status`                                     | Schema-validated DB/worker/scheduler/configuration status; 503 on DB failure |
| Other API routes                                                | 404; no financial mutation endpoints                                         |

The web proxy allowlists these GET routes and times out after five seconds with `API_UNAVAILABLE`. It never forwards arbitrary URLs, browser authorization, or write requests. Status polling every ten seconds reports refresh failures, retains last observed timestamps, and does not continue to label cached values online after a failed refresh. Displays use `America/Vancouver`; operational storage uses UTC. `America/New_York` is reserved for future exchange session logic, not a claim that a holiday calendar exists yet.

## Database and jobs

The checked-in Drizzle migration creates `worker_heartbeats` and `demo_job_runs`; Drizzle tracks applied migrations in its own schema. `pg-boss.start()` initializes its separate `pgboss` schema from the independent worker. Queue `m2d.foundation-demo.v1` validates the payload in `fixtures/foundation-demo.json`, expires a running job after 30 seconds, and allows three retries with backoff. An unexpected queue error stops the worker so the restart policy can recover; heartbeat persistence errors are reported without logging credentials.

Generate subsequent migrations with `pnpm db:generate` after a schema edit; inspect the SQL before applying. `pnpm db:migrate` runs compiled migrations using the root `.env`. A production migration failure exits before the API starts. Never use schema push or drop/recreate to bypass migration errors.

## Native development

Copy `.env.example` to `.env` if not already present. The Compose URL is built from `POSTGRES_*`; native processes use `.env`'s localhost `DATABASE_URL`. Do not run both native and container apps on the same web/API ports.

```powershell
docker compose -f compose.yaml -f infrastructure/compose.dev.yaml up --detach postgres
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate
pnpm dev
```

Backend development watches compiled JavaScript; after backend edits run `pnpm build` (or `pnpm --filter @m2d/api... --filter @m2d/worker... build`). Next.js has its normal development hot reload. API defaults to `127.0.0.1:3001`; web to `127.0.0.1:3000`. For a different native proxy address set `API_INTERNAL_URL` in the shell running web; Next does not load the repository root `.env` automatically. Never copy provider credentials into web configuration.

## Integration tests

Use a **disposable, separate database**: the test suite inserts operational rows and configures its demo queue. Never point it at the application database. Tests fail explicitly if the test URL is absent.

```powershell
docker compose -f compose.yaml -f infrastructure/compose.dev.yaml up --detach postgres
docker compose exec postgres createdb -U m2d m2d_test
$env:TEST_DATABASE_URL='postgresql://m2d:m2d-local-only@127.0.0.1:5432/m2d_test'
pnpm test:integration
```

The tests apply migrations twice, enforce SQL constraints, verify persisted heartbeat, upsert one pg-boss schedule, and simulate a failure after DB commit but before queue acknowledgement. The retried job must produce one historical row. Unit tests cover configuration, decimal-string and confirmation contracts, stale/future timestamps, job payload validation, liveness/readiness, sanitized failures, and absent mutation endpoints. Playwright verifies dashboard status, future-feature placeholders, API failure feedback, and mobile overflow.

## Data protection

`docker compose down` preserves `m2d_postgres_data`. Use PostgreSQL custom-format backup inside the container, then copy it out without piping binary data through PowerShell:

```powershell
docker compose exec postgres pg_dump -U m2d -d m2d -Fc -f /tmp/m2d-backup.dump
docker compose cp postgres:/tmp/m2d-backup.dump ./data/backups/m2d-backup.dump
```

Choose a new backup filename to preserve earlier backups. Keep research/uploads alongside database backups when those features exist. Restore only into a new, separately named database; M8 will add a verified restore/portability workflow. No existing volumes or history are removed by M0 scripts.

## Verification record

Verified on October 30, 2026 (America/Vancouver), using Windows Node 26.8.2 / pinned pnpm 10.32.1 and Docker Desktop Linux containers on Node 24.11.0 / PostgreSQL 17.6:

| Check                                                          | Result                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` in container builds           | Passed                                                                                                        |
| `pnpm format:check`                                            | Passed                                                                                                        |
| `pnpm lint`                                                    | Passed, zero lint warnings                                                                                    |
| `pnpm typecheck`                                               | Passed, including test/config TypeScript                                                                      |
| `pnpm test`                                                    | 11 unit/API tests passed                                                                                      |
| `pnpm test:integration`                                        | 2 real PostgreSQL/pg-boss tests passed against a separate disposable database                                 |
| `pnpm build`                                                   | Passed on Windows; all three application images also built successfully on Linux                              |
| `docker compose config --quiet`                                | Passed                                                                                                        |
| `docker compose up --build --detach --wait --wait-timeout 180` | Passed; all four services healthy, no API keys configured                                                     |
| `pnpm test:e2e`                                                | 2 Playwright tests passed, repeated successfully after final rebuild/restart                                  |
| Restart persistence                                            | All 5 pre-restart demo rows retained; exactly 1 cron schedule and 1 applied Drizzle migration remained        |
| Scheduled execution                                            | Both startup and later scheduled jobs observed in PostgreSQL, with distinct IDs and UTC completion timestamps |
| Visual inspection                                              | Desktop dashboard screenshot reviewed; mobile width and unavailable-API feedback verified by Playwright       |

[Verified dashboard screenshot](screenshots/m0-desktop.png).

The M0 UI was revised after user feedback into a compact light workspace: off-white canvas, white cards, near-black text, gray borders, and blue selected navigation. A simple Dashboard heading, compact operational status, and explicit portfolio/activity empty states replace the promotional hero and decorative cards. Status shows a live countdown until the next refresh, then “Refreshing…” while the request is pending. The ten-second countdown restarts after either success or failure and uses elapsed wall-clock time to avoid accumulating timer drift. Availability labels remain visible; this redesign adds no later-milestone functionality.

The first checks caught and resolved an invalid-URL refinement exception, missing test TypeScript settings, and a lint import issue. The host pnpm 11 build-approval behavior differed from the pinned version; verification therefore used `npm exec --yes --package=pnpm@10.32.1 -- pnpm ...`. Build tooling reports upstream deprecation notices for ESLint 9 and Drizzle Kit's esbuild-kit transitive dependencies; builds/checks pass. The disposable integration container was stopped; the application stack and its persistent volume remain intact and running.

At initial verification, the supplied folder had no Git repository or configured remote, so the GitHub Actions workflow could not be dispatched; its constituent local checks were executed. The project is now being published to `arthurcui/m2d`, with the M0 implementation proposed through a pull request. GitHub check results are recorded on that PR. Dependency/image installation needs network; application and tests never need paid keys. Backup restore, production remote hosting, financial workflows, market data, inference, and analysis modes are outside M0 and were not claimed as verified.
