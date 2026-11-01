# 12 — Docker Operations, Data Protection and Cloud Path

## 1. Local Compose deployment
Services: `web`, `api`, `worker`, `postgres` with health checks and restart policies. Only `web` exposed on `127.0.0.1:3000` by default; API internal through web rewrite/proxy or localhost dev route. PostgreSQL not published to host unless developer opts in. `web` and `api` wait for schema-ready database.

Named/mounted volumes: `postgres_data` (database), `./data/uploads`, `./data/research`, `./data/exports`, `./data/backups`. Database migrations run as explicit one-off startup task or operator command, never concurrently from all three app processes.

Use release-pinned Postgres/Node images that work with pgvector if enabled. Generate final compose and Dockerfiles at M0; this design pack intentionally contains no untested compose.

## 2. `.env.example` requirements
The example below describes normal configured operation from M2 onward. At M0, the scaffold's example uses `LLM_PROVIDER=fixture` and `LLM_MODEL=fixture-v1` so it starts without model integrations or keys. After M2, OpenAI is the initial real provider; offline profiles continue to select fixture explicitly.

```dotenv
APP_NAME=M2D
APP_TIMEZONE=America/Vancouver
MARKET_TIMEZONE=America/New_York
BASE_CURRENCY=USD
APP_MODE=local
PORT=3000
DATABASE_URL=postgresql://m2d:<set-locally>@postgres:5432/m2d
LLM_PROVIDER=openai
LLM_MODEL=
OPENAI_API_KEY=
# Reserved for future adapters; not needed for OpenAI:
# GEMINI_API_KEY=
# ANTHROPIC_API_KEY=
ANALYSIS_MODE_DEFAULT=standard
# Deployment ceilings; per-mode profiles are lower or equal:
LLM_MAX_STEPS=16
LLM_MAX_TOOL_CALLS=24
LLM_REQUEST_TIMEOUT_MS=60000
LLM_RUN_TIMEOUT_MS=300000
LLM_MAX_OUTPUT_TOKENS=8192
# Optional application cost caps in USD; blank means unset, not zero:
LLM_MAX_RUN_COST_USD=
LLM_DAILY_BUDGET_USD=
MARKET_PROVIDER=fixture
MARKET_DATA_API_KEY=
SEC_USER_AGENT=M2D personal research contact@example.com
STOCK_QUOTE_FRESHNESS_SECONDS=90
OPTION_QUOTE_FRESHNESS_SECONDS=180
FEATURE_RESEARCH_EMBEDDINGS=false
```
`contact@example.com` is a placeholder; configure honest contact identification before SEC calls. Do not commit a real `.env` or keys. The optional IBKR market-data connection stores its own read-only OAuth tokens in a private API credential volume (ignored `data/credentials` for native development); never include these files in source control or unprotected backups. See `IBKR_MCP.md` for callback origin, renewal, and revocation.

Set `LLM_MODEL` to an explicit model available to the configured API project; this design does not hardcode a model or account entitlement. The step/token/timeout numbers above are initial engineering defaults, not provider guarantees. For offline development and CI set `LLM_PROVIDER=fixture` and `LLM_MODEL=fixture-v1`; no API key or network is required. Only the selected real provider's credentials are required. Reserved providers return `LLM_PROVIDER_NOT_IMPLEMENTED` until their adapters and contract tests exist.

Quick/Standard/Extensive profiles are versioned application policy in `packages/agent`, specified in `15_ANALYSIS_MODES.md`. Environment limits above are deployment ceilings, not a request to spend their full budget. `LLM_MAX_STEPS` means maximum model-call attempts including retries; `LLM_MAX_TOOL_CALLS` separately limits tool-call attempts including retries. Standard permits 8 model-call attempts, 12 tool-call attempts and a 120-second run deadline; Extensive can use higher limits within these ceilings. Resolve each effective limit as the minimum of its mode profile, deployment ceiling and remaining applicable run/daily/provider allowance. `LLM_REQUEST_TIMEOUT_MS` is additionally bounded by time remaining in the mode's run deadline. Report a capped profile instead of silently changing its mode or raising ceilings.

Inject `OPENAI_API_KEY` into `api` and `worker` at runtime, never into `web`, `NEXT_PUBLIC_*`, Docker build arguments, images, browser storage, logs or API responses. Commit only placeholder configuration. Real `.env` files are ignored by Git and excluded from image build contexts. On a private cloud host, inject the same environment variables through its secret facility. No ChatGPT login, OAuth callback, subscription-token handling or browser credential import is part of setup. See `14_LLM_PROVIDERS.md` for provider configuration and failure behavior.

Missing/invalid AI configuration blocks AI calls and marks AI status unconfigured; portfolio reads and explicit manual entry remain usable. Checking configuration does not make a paid model request. Scheduled AI jobs honor the same token/time and configured cost limits as interactive runs. Cost caps are application estimates; record reported token usage separately, show unset/unknown cost status, and account for in-flight calls before dispatching further work.

## 3. Startup and operation commands (Codex to implement)
```bash
cp .env.example .env
pnpm install
pnpm lint && pnpm typecheck && pnpm test
# local Docker-first usage:
docker compose up --build -d
docker compose ps
docker compose logs -f api worker
```

## 4. Backups, restore, health
- Versioned Postgres dumps (`pg_dump`) plus uploaded raw files; verify restore to a fresh stack periodically. Database and file manifest need coordinated backup timestamps.
- Provide UI/CLI export for canonical workbook, history JSON/CSV and trade journal.
- `/health/live`, `/health/ready`, `/system/status`; show worker last-success, scheduler state, market/AI provider costs, quote data delays and disk volume health.
- `/system/status` exposes AI provider, model, configured/available status and usage summaries only; it never returns credentials or opaque continuation. Database/service readiness and optional AI-provider readiness are reported separately.
- No internet connection required for fixture-mode development or portfolio bookkeeping. Market/research/LLM features degrade and report unavailable status.

## 5. Later cloud deployment
Same images and schema; environment switches DB endpoint, file storage adapter and network exposure. Use private VPN/tunnel or equivalent instead of designing public SaaS authentication. Preserve data snapshots and original import hashes.

## 6. Operational finance risks
- Outdated holdings or missed cash adjustments create incorrect recommendations; display portfolio last-updated timestamp and prompt to reconcile periodically.
- Market data licenses and quote entitlements may not permit real-time displays without a paid tier.
- Avoid direct trade execution even when cloud-hosted; this product is a decision-support journal.
