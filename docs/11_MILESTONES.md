# 11 — Implementation Roadmap for Codex

Implement strictly milestone-by-milestone, with tests and screenshots or UI verification for each. Avoid waterfall coding of the complete product.

## M0 — Runnable foundation
**Deliver:** pnpm TypeScript monorepo, Next.js starter UI, Fastify `/health`, worker process, PostgreSQL container, Drizzle migrations, `pg-boss` initialization, fixture mode, .env.example with `LLM_PROVIDER=fixture`, `LLM_MODEL` and a blank backend/worker `OPENAI_API_KEY`, docker compose, CI lint/typecheck/unit, local README. Document the provider boundary from `docs/14_LLM_PROVIDERS.md`; functional LLM adapters remain in M2.
**Accept:** `docker compose up --build` -> web opens, API health passes, worker heartbeat/job recorded, DB persists across restart, no paid keys or inference calls.

## M1 — Authoritative local portfolio
**Deliver:** accounts/instruments, baseline+incremental event model, deterministic projection, cash/cost/option logic, canonical Excel upload (staging, row errors, diff, atomic confirm), AI workbook parsing with plain-language clarification (user-requested scope extension, 2026-10-31), account/position/cash dashboard, change log, golden tests. General chat and incremental natural-language changes remain M2. User-facing manual mapping and single-change forms are removed; fixture parsing remains explicit offline mode.
**Accept:** canonical workbook with 7 accounts imports; missing position zeroes only on confirm, history preserved; short option and cash values correct; duplicate imports idempotent.

## M2 — Natural-language updates + chat shell
Include Quick/Standard/Extensive selection with Standard default, saved workspace preference, versioned execution policies, mode/run metadata and explicit deeper follow-up under `docs/15_ANALYSIS_MODES.md`. The selected mode changes depth and work allowance only; research/strategy features still arrive at their existing milestones.

**Deliver:** provider-neutral `LlmProvider` contracts/factory/adapters in `packages/llm`, fixture and OpenAI implementations, direct OpenAI API access through backend/worker `OPENAI_API_KEY`, `LLM_PROVIDER`/`LLM_MODEL` configuration, typed NL extraction and clarification, preview/confirm UI, agent session persistence, basic streaming chat. Follow `docs/14_LLM_PROVIDERS.md` for canonical history, opaque provider/model/version-scoped continuation, capability checks, normalized results/errors and per-run budgets. `packages/agent` retains orchestration/tools; model cannot commit writes. No ChatGPT sign-in/OAuth/session credentials; Gemini and Anthropic Claude adapters are future work.
**Accept:** "sell to open 1 covered call" creates correct candidate and cash diff; ambiguous inputs ask follow-up; no portfolio change before confirmation. Offline fixture and mocked OpenAI tests cover multi-step continuation, unsupported capabilities, exhausted budgets, cancellation and missing selected key; native SDK types stay inside adapters. No external orchestration framework or additional provider implementation.

## M3 — Market data and valuation
**Deliver:** provider interfaces + fixture adapter, one real market provider integration if configured, stock OHLCV/quotes, FX, options chain/snapshot where licensed; timestamp/session/freshness tracking; NAV, P&L with quality labels, charting.
**Accept:** delayed/closed prices labelled; unavailable options Greeks degrade cleanly; no provider required to run fixture E2E.

User-authorized M3 extension: optional IBKR hosted MCP for allowlisted market data and separate read-only authorization. No broker-account synchronization or trading tools. See [IBKR setup and limits](IBKR_MCP.md); M4 is documented below.

## M4 — Research and motive intelligence
**Deliver:** SEC company filings/XBRL importer, upload PDF and plain text, document version/hash, extract claims and citations, company timeline, compare filings, full-text search first; optional pgvector later.
**Accept:** new filing changes appear with before/after and source links; older historical view preserves old data.

## M5 — Risk and trade planner
**Deliver:** exposures, option coverage, expiration review, stress scenarios, supported option payoff calculators, strategy analysis tool, structured trade plans and validation rules, basic chart for payoff-at-expiry.
**Accept:** covered vs uncovered tests; correct signs/fees, no recommendation actionable with stale or incomplete data; exit/invalidation and main risk mandatory.

## M6 — Autonomous monitoring and opportunities
**Deliver:** pg-boss schedule jobs, holdings watch, watchlists, threshold/catalyst scanners, daily review, alert dedup, lifecycle tracking, sorted opportunities dashboard and manual run controls.
**Accept:** triggers once per material event, tracks subsequent changes, reports last-run/offline status, suppresses repetitive stale alerts.

## M7 — Performance, backtesting and refinement
**Deliver:** journal links signal->self-reported fill, simulated/actual separation, outcome tracking, fees and slippage, benchmark comparisons, walk-forward backtest with point-in-time data; weekly review.
**Accept:** no look-ahead in fixtures, NAV changes not misrepresented as TWR, strategy results include sample size/uncertainty, rules versions fixed at signal issuance.

## M8 — Cloud portability and quality hardening
**Deliver:** container portability, optional S3 storage adapter, backups/restores, import/export, system health and API-cost dashboard; personal private cloud deployment guide.
**Accept:** local volume migration tested against fresh Postgres instance, no implicit SaaS or broker connection work.

## Sprint rule
For each milestone Codex must: (1) make short implementation plan, (2) implement vertical slices, (3) run tests, (4) summarize progress and commit-ready files, (5) stop. Do not begin later milestones without the user's next instruction.

## M1 shared Agent and identity extension

The global Agent panel now remains mounted across navigation and preserves unfinished portfolio import work. Unfamiliar account-bearing tabs require new-account/rename selection; rename retains stable account IDs and historical baselines. Optional transactionDate is holding metadata only. These user-requested M1 extensions do not enable M2 general trade-language chat or later research/analysis functions. See M1_PORTFOLIO.md and ADR-031.

M2 implementation: see [M2_CHAT.md](M2_CHAT.md) for the shipped boundaries and cost-accounting limitation of the separate M1 workbook path. M3 implementation: see [M3_MARKET.md](M3_MARKET.md) for market evidence, valuation, fixtures, provider configuration and limits. M4 implementation: see [M4_RESEARCH.md](M4_RESEARCH.md) for document imports, SEC configuration, citations, historical correctness and limitations, and [COMPANY_SEARCH.md](COMPANY_SEARCH.md) for shared keyword/semantic retrieval. M5 implementation: see [M5_RISK.md](M5_RISK.md) for stock/ETF and option calculations, hypothetical plans and validation limits. M6 and later remain unimplemented.

User-authorized M4 source extension: saved public IR/fund/OCC/macro/news links and bounded manual imports; see [RESEARCH_SOURCES.md](RESEARCH_SOURCES.md). This does not add M6 scheduling.
