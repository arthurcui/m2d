# M²D — Move · Motive · Decision

**See the Move. Understand the Motive. Make the Decision.**

**Status:** M4 research is implemented: SEC filing/XBRL retrieval, PDF/text uploads, immutable source history, full-text search, report comparison and cited Agent discussion. See [M4 setup and limits](docs/M4_RESEARCH.md). M3 — Market evidence, optional Massive Basic (free end-of-day), Twelve Data and [IBKR hosted MCP](docs/IBKR_MCP.md) integration, indicative NAV/P&L, OHLCV charts and saved valuations implemented on the M1/M2 portfolio Agent. See [M3 market setup and limits](docs/M3_MARKET.md). See [M2 implementation notes](docs/M2_CHAT.md) for usage, limits and verification. The design specification (revision 1.2) below also describes future milestones. See [M1 implementation notes](docs/M1_PORTFOLIO.md) for accounting rules, Excel templates, confirmation contracts, verification, and limitations; [M0 notes](docs/M0_FOUNDATION.md) retain foundation details.

M4 also includes a [public research source library](docs/RESEARCH_SOURCES.md) for issuer reports, fund documents, options notices, economic releases and news summaries. Set `RESEARCH_SOURCE_MODE=live` for user-triggered public retrieval; the default is offline fixture mode.

## Run locally

Prerequisites: Docker Engine with Compose v2 or later (Docker Desktop on Windows). Initial image/dependency downloads require network access; the running fixture stack needs no API keys or paid services.

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
docker compose up --build --detach --wait --wait-timeout 180
docker compose ps
```

Open [M²D](http://127.0.0.1:3000). The dashboard shows database readiness, a worker heartbeat every 10 seconds, and the last persisted demo job (startup probe, then every minute UTC). The scheduled job can take up to roughly 90 seconds to appear. Only web is exposed to localhost; API and PostgreSQL remain on the Compose network.

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/v1/health/ready
Invoke-RestMethod http://127.0.0.1:3000/api/v1/system/status
docker compose logs --tail 100 api worker
docker compose restart
docker compose down
```

On macOS/Linux use `cp .env.example .env` and `curl` in place of the PowerShell commands. `down` preserves the named database volume. **Do not use `down --volumes` on a workspace whose data you want to retain.** The example password is for this private local stack only; use a URL-safe replacement consistently before initial DB creation. Changing it after initialization also requires changing the database role password.

### Development and checks

Use Node 24 LTS (container/CI version: 24.11.0) and pnpm 10.32.1. If another pnpm is installed, invoke the pinned version with `npm exec --yes --package=pnpm@10.32.1 -- pnpm <command>`.

```powershell
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
docker compose config --quiet
pnpm exec playwright install chromium
pnpm test:e2e
```

Portfolio E2E writes fictional records: run it only in a fresh disposable Compose project with E2E_ALLOW_PORTFOLIO_WRITES=1. See [M1 verification instructions](docs/M1_PORTFOLIO.md#verification). Unit tests are offline and need no database or API key. CI also runs PostgreSQL integration tests and the full browser suite.

The Portfolio page now supports multi-tab Excel import with inferred column mappings and confirmed full-state replacement, revision-guarded preview/confirmation, and immutable change history. Upload an existing workbook and review its interpreted portfolio; the replacement takes effect when confirmed. Individual changes use the persistent Agent chat and explicit preview confirmation. AI workbook interpretation is implemented in M1 through a provider-neutral OpenAI/fixture boundary. It creates a validated replacement preview and asks plain-language questions for missing facts; no column mapping is required. M3 adds fixture and optional Twelve Data market evidence, FX, indicative valuation and charts. M2 adds general chat, incremental natural-language updates, tool continuity, and Quick/Standard/Extensive work allowances. M4 adds SEC filings/XBRL, PDF/text research uploads, immutable evidence, shared keyword/semantic company search, report comparisons and cited Agent discussion. Risk planning and automated monitoring remain later milestones. See [M4 research setup and limits](docs/M4_RESEARCH.md) and [company search](docs/COMPANY_SEARCH.md).

## Current AI access decision

M²D calls the **OpenAI API directly**, using `OPENAI_API_KEY` from the backend/worker environment. It does not use ChatGPT sign-in, subscription sessions, browser cookies, or OAuth for model access. A provider-neutral `LlmProvider` contract isolates native SDKs so Google Gemini and Anthropic Claude can be added later. Version 1 implements OpenAI and an offline fixture adapter; future adapters are extension points, not completed integrations. See `docs/14_LLM_PROVIDERS.md`.

## User-selectable analysis modes

Offer **Quick**, **Standard** (default), and **Extensive** beside the chat input and on manual analysis requests. Modes change research depth, comparison scope and bounded compute/tool budgets. All modes retain the same financial validation, quote freshness and portfolio-confirmation rules. Keep conclusions concise, with supporting detail expandable. Modes are separate from provider/model selection; see `docs/15_ANALYSIS_MODES.md`.

## Mission

Build a single-user, standalone, Docker-first AI investment intelligence and decision-support application that watches the market and the user's manually maintained multi-account portfolio, explains drivers, proposes actionable trades/management plans, and measures its own recommendations against subsequent outcomes. Optimize for **risk-adjusted, after-cost returns**, not quantity of alerts or generic commentary.

## Invariants / non-goals

- **No OpenClaw or other ready-made agent orchestrator.** Implement a small, testable agent runtime within M²D using an LLM provider API.
- **No broker account synchronization, brokerage passwords, or order placement.** Accounts remain manually defined. The user-authorized M3 exception is optional IBKR hosted MCP for allowlisted market data, using separate read-only OAuth authorization; see [IBKR setup](docs/IBKR_MCP.md).
- **No tenancy, multi-user management, signup, RBAC, subscriptions, billing, or SaaS infrastructure.** One personal workspace.
- Portfolio updates: (1) natural-language instructions -> validated preview -> confirm; (2) uploaded Excel workbook -> validated full-state replacement preview -> confirm. Excel is authoritative **current state**, not a replacement for history.
- Market, financial, news, filings, and options data may be imported from external third-party/public data services.
- Local Docker Compose now; move same containers to a private cloud host later.
- LLM credentials stay in server-side environment configuration. Portfolio, research, risk and agent orchestration depend on M²D contracts, not provider SDK types.
- AI never invents portfolio quantities, prices, option contracts, events, or calculated P&L. Never place a trade.
- Data fidelity before AI features; avoid fabricated performance history, stale-price recommendations, and backtest look-ahead bias.

## Read in this order

1. `AGENTS.md` — permanent coding rules.
2. `docs/01_PRD.md` — workflows and scope.
3. `docs/02_ARCHITECTURE.md` — services, modules, runtime and boundaries.
4. `docs/03_DATA_MODEL.md` — domain entities, money/accounting, state/history semantics.
5. `docs/04_PORTFOLIO_INPUTS.md` — natural-language and Excel update contract.
6. `docs/05_MARKET_INGESTION.md` — market data, research, provenance, freshness.
7. `docs/06_AGENT.md` — tool loop and write protections.
8. `docs/07_TRADING_RISK.md` — options/risk/opportunity decisions and performance.
9. `docs/08_MONITORING_UI.md` — jobs, alerts, dashboards, chat.
10. `docs/09_API_CONTRACTS.md` — route and event contracts.
11. `docs/10_TESTING.md` — acceptance and regression cases.
12. `docs/11_MILESTONES.md` — increment-by-increment implementation.
13. `docs/12_OPERATIONS.md` — Docker, environment, backups, migration.
14. `docs/13_ADRS.md` — architecture decision log.
15. `docs/14_LLM_PROVIDERS.md` — direct API access, provider contract, configuration and future adapters.
16. `docs/15_ANALYSIS_MODES.md` — Quick, Standard and Extensive behavior, selection and execution policies.

## Target repository (to be implemented by Codex)

```text
m2d/
├── apps/
│   ├── web/                        # Next.js React frontend
│   ├── api/                        # Fastify HTTP/SSE API
│   └── worker/                     # scheduler, ingestion, scanning
├── packages/
│   ├── domain/                     # domain types, money, contracts
│   ├── db/                         # Drizzle schema, migrations
│   ├── portfolio/                  # baseline+events projection
│   ├── market/                     # quote/FX/options provider adapters
│   ├── research/                   # filings, documents, RAG
│   ├── risk/                       # exposure, Greeks, scenarios
│   ├── strategy/                   # candidate generation, trade plans
│   ├── performance/                # journal, P&L, evaluation
│   ├── agent/                      # custom LLM tool loop
│   ├── llm/                        # provider contracts, factory, OpenAI/fixture adapters
│   ├── monitoring/                 # watches, signals, alert routing
│   ├── ingestion/                  # Excel and other file parsers
│   └── ui/                         # optional shared UI primitives
├── docs/
├── fixtures/
├── tests/
├── infrastructure/
├── AGENTS.md
├── .env.example
├── compose.yaml
├── pnpm-workspace.yaml
└── package.json
```

## Quality bar

Each milestone must end with runnable code, tests, sample data, reproducible commands, known limitations and screenshots or route/UI verification. Brokerage connections are limited to the explicitly authorized IBKR market-data MCP adapter. No account synchronization, order execution, financial claims without evidence, or invented history.

### Current M1 account and Agent behavior

Many broker/platform accounts each own cash and holdings. Holding imports require asset class, equity symbol and quantity; description and unit cost are optional. Currency defaults to USD when absent. Missing cost stays unknown; option groups retain individual signed legs. Agent appears at the right on wide screens and at the bottom on narrow screens, can be closed/reopened, asks import questions and contains explicit replacement confirmation. Confirmed safe format mappings are stored in PostgreSQL for matching later uploads. See [M1 portfolio behavior](docs/M1_PORTFOLIO.md) for reuse boundaries and supported option contracts.

### Shared Agent and schema documentation

Agent is available throughout the app; M1 handles portfolio imports and clarification. Navigation preserves unfinished portfolio work. New account tabs require a new-account or rename choice; renames preserve stable IDs and history. Holdings optionally include an ISO transaction date. See [the generated database ERD](docs/ERD.md) and [M1 behavior](docs/M1_PORTFOLIO.md). Run `pnpm docs:erd` after schema edits; CI checks the diagram for drift.

See [Analyst Research](docs/ANALYST_RESEARCH.md) for public bank sources, categorized uploads, cited fields and Agent comparisons.
