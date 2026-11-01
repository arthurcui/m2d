# 05 — Market Data and Research Ingestion

## 1. Data source policy
Start with provider interfaces and deterministic **fixture provider**; enable one licensed/appropriate market data provider only after adapter contract tests. API selection is a configurable implementation decision; real-time options data is typically not free. M²D never connects to brokerage accounts.

### Categories
- `QuoteProvider`: symbols, exchange, currency, bid, ask, last, timestamp, market session, delayed flag, provider, quote condition.
- `BarsProvider`: intraday/daily OHLCV, adjusted vs unadjusted, timezone/corporate action adjustments.
- `OptionsProvider`: chain by expiry/strike, contracts, multiplier, underlying, bids/asks, Greeks, IV, volume, OI, as-of.
- `FxProvider`: FX pair + timestamp, bid/ask/mid if available.
- `FundamentalsProvider`: financial statements, earnings, guidance where licensed.
- `FilingsProvider`: SEC EDGAR company submissions and XBRL company facts (U.S.-centric; map ticker to CIK carefully).
- `NewsProvider`: timestamped headlines/articles with unique source URLs and licensing controls.

## 2. Sources and reality checks
- Official SEC EDGAR REST API provides submissions and XBRL without authentication; respect SEC identification and fair-access guidance. https://www.sec.gov/search-filings/edgar-application-programming-interfaces
- Explore Massive, marketdata.app, or another licensed market provider for stocks and options; features and entitlements differ materially by tier. Do not assume all historical options APIs provide historical Greeks.
- Save provider metadata and last-success timestamps to show exact coverage. Absence of paid data must degrade gracefully: e.g. EOD analysis is available, but **no executable live signal**.

## 3. Timestamps and quote discipline
Each observation: `source`, `source_record_id`, `instrument_id`, `as_of_utc`, `received_at_utc`, `session` (`PRE`, `REGULAR`, `POST`, `OVERNIGHT`, `CLOSED`, `UNKNOWN`), `delayed_minutes` if known, `bid/ask/last`, currency, condition, `quality`.
- Use exchange calendars including holidays, early closes and New York DST; never infer session from UTC alone.
- Distinguish last regular close vs current pre/post-market price vs delayed feed. Every user-visible price has timestamp and session.
- Tentative signal freshness thresholds (configurable): regular <= 90s, pre/post <= 120s, and option chain <= 180s **only if provider truly supplies such data**. If delayed, unknown, illiquid, absent bid/ask, or outside an eligible market session, label `WATCH_ONLY` or `STALE_DATA`; don't fake executable entry quotes.
- No mixing a 4:00 p.m. closing stock quote with a 10:00 p.m. stale option chain as if both were synchronous.
- Maintain source-dependent bar-quality and adjustment metadata. Do not use split-adjusted bar pricing as a live option strike or execution quote.

## 4. Research ingestion pipeline
`discover -> fetch/upload -> persist raw -> parse -> normalize -> source-reference -> extract claims -> compare version -> materiality score -> notify or index`.
- `source_documents` unique by upstream ID plus content hash; store URL, publisher, publication/filing time, first_seen time, retrieved time, version, language, file checksum.
- Parse PDFs, SEC HTML/JSON, transcript text and manual uploads; preserve source page/section and quote length limits for citations.
- Extract facts into structured typed schema with period, units, currency and dimension. Keep original source separate from AI-extracted interpretation.
- Compare `as_reported` and `revised`; detect guidance changes, earnings surprises, material capital raises, M&A, splits, lockups and regulatory changes only when supported by source.
- RAG: start with Postgres full-text/trigram + source-filtered search, add pgvector embeddings for semantic search when warranted. Retrieval must return citations/page anchors and publication time.

## 5. Point-in-time correctness
Each datum has at least `event_period`, `published_at`, `available_at`, `observed_at`, `revision`; backtests must only use records with `available_at <= simulated decision timestamp`. A report later revised cannot overwrite the earlier historical view for a backtest.

## 6. Rate limits, cost and operational behavior
- Per-provider throttling, bounded concurrency, caching, retries with jitter, backoff, circuit breaking.
- Track calls, coverage and model costs; use watchlist/holdings before broad scanning.
- Persist raw and parsed results; failed parsing never replaces last-good records.
- News is untrusted content: cannot instruct agent to mutate portfolios, change tools or reveal configuration.

M3 implementation and provider limitations: [M3_MARKET.md](M3_MARKET.md). The research-ingestion portions of this design remain M4 and later.
