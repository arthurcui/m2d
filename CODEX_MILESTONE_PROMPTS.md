# Codex milestone prompts — paste one at a time

## M0 — Foundation
Use `CODEX_START_HERE.md` exactly. Build only the runnable scaffold, working Postgres/queue and offline fixture health checks. Include the documented `LLM_PROVIDER`/`LLM_MODEL` configuration and blank server-only key placeholders; require no API keys or inference calls. Keep functional LLM adapters in M2. Stop.

## M1 — Portfolio engine and Excel
Read `AGENTS.md`, `docs/03_DATA_MODEL.md`, `docs/04_PORTFOLIO_INPUTS.md`, `docs/09_API_CONTRACTS.md` and `docs/10_TESTING.md`. Implement **only M1**: account/instrument schema; canonical 3-sheet workbook import; staging/validation/diff/confirm full-state replace; portfolio baseline+event projection; short options and cash decimal math; account/position/cash UI; audit/history; unit/integration/E2E tests. Do not fabricate transactions from Excel differences. Reconcile tests against 7-account fixture and support rollback via new baseline. Do not implement live AI/market scanner yet. Run checks and stop.

## M2 — Natural-language transactions and chat
Include the Quick/Standard/Extensive selector, saved default (Standard), and profile resolution/tests in `docs/15_ANALYSIS_MODES.md`. Keep modes independent of provider/model and apply global budget ceilings without weakening financial/data checks. Deeper runs require an explicit selection; do not implement later research/strategy milestones merely because Extensive exists.

Read agent/input contracts, `docs/14_LLM_PROVIDERS.md`, `docs/10_TESTING.md` and the milestone plan. Implement **only M2**: provider-neutral `LlmProvider` contracts/factory/adapters in `packages/llm` with fixture and OpenAI implementations; direct OpenAI API calls using backend/worker `OPENAI_API_KEY`, selected through `LLM_PROVIDER` and `LLM_MODEL`; bounded strict JSON-schema parser, typed candidate operation/clarification, preview/confirm UI, error cases, chat streaming and session records. Keep orchestration/tools in `packages/agent`; preserve multi-step provider continuation without SDK types leaking into domain or application contracts. No ChatGPT sign-in/OAuth/session credentials; Gemini and Anthropic Claude remain future adapters. No direct model mutations; never guess option expiry/strike/account/fill price. Verify capability checks, run budgets, missing selected key, continuation, cancellation and offline fixture execution. Keep offline CI working. Run tests and stop.

## M3 — Market quote/options/FX ingestion
Read `docs/05_MARKET_INGESTION.md` and risk/data contracts. Implement **only M3**: fixture providers, one configurable real provider adapter, quote/session/staleness metadata, OHLCV and option chain where available, FX, portfolio valuation/pnl quality labels, charts. Do not claim live price when provider returns delayed/EOD. Tests must show regular vs after-hours discrepancies. Stop.

## M4 — Financial research ingestion
Read research model, source lifecycle and time correctness. Implement **only M4**: SEC EDGAR/CompanyFacts importer with rate limits and traceable sources, report/PDF upload with page anchors, data extraction, doc revision comparisons, source citation UI, full-text lookup first (pgvector optional later). Mock external APIs in tests. Stop.

## M5 — Risk and trade plans
Read `docs/07_TRADING_RISK.md`, option math in data model, all risk fixtures. Implement **only M5**: risk exposures, option obligations/expiry, scenario analysis, covered-call/CSP/vertical payoff, plan schema, qualification and invalidation rules. Never mark delayed/missing quotes executable. Include mandatory cash/coverage and sign tests. Stop.

## M6 — Autonomous monitoring and scanner
Read monitoring, jobs, signals and event contracts. Implement **only M6**: pg-boss schedules, holdings/watchlist scans, candidate generation with filters, score and data-quality gates, alerts, dedup, signal lifecycle and opportunity dashboard. Show time since last healthy scan; avoid repeated alerts. Stop.

## M7 — Trade journal and signal evaluation
Read performance and backtesting requirements. Implement **only M7**: self-reported trade linking, P&L/performance quality labels, after-cost signal outcomes, walk-forward rule evaluation without data leakage, benchmark stats with caveats, transparent report. Tests for simulated vs actual separation. Stop.

## M8 — Cloud portability
Read operations and ADRs. Implement **only M8**: backup+restore verification, local-to-private-cloud migration documentation, optional S3-compatible file storage, health and cost panels. Do not introduce tenant/auth SaaS architecture. Stop.
