# 03 — Data Model and Accounting Semantics

## 1. Core entities (primary keys UUID unless provider-defined)
| Entity | Essential columns | Purpose |
|---|---|---|
| `accounts` | id, account_key unique, institution_label, display_name, account_type, base_currency, active, created_at | Manually defined accounts; NO broker access |
| `app_settings` | singleton key, default_analysis_mode, settings_revision, updated_at | One personal workspace's preferences; no user/tenant model |
| `instruments` | id, asset_type, ticker, exchange, currency, security_identifier, underlying_id, option_right, strike NUMERIC, expiry DATE, multiplier NUMERIC, deliverable JSONB, adjusted_contract | Immutable instrument identity; symbol alone not unique |
| `portfolio_baselines` | id, revision, effective_at, recorded_at, source_type, upload_id nullable, comment, status | Authoritative current-state reset events |
| `baseline_positions` | baseline_id, account_id, instrument_id, signed_qty NUMERIC, avg_cost NUMERIC, cost_currency, cost_basis_method, source_row | Entire current positions at baseline |
| `baseline_cash` | baseline_id, account_id, currency, amount NUMERIC, source_row | Entire current cash at baseline |
| `portfolio_events` | id, kind, account_id, effective_at, recorded_at, payload JSONB, source, idempotency_key unique, reverses_event_id, baseline_revision, confirmation_id | Confirmed incremental portfolio actions |
| `position_lots` | id, account_id, instrument_id, originating_baseline_id/event_id, quantity_open, unit_cost, acquisition_at, data_quality | Lot accuracy only where known; baseline pseudo-lots allowed |
| `portfolio_projections` | account_id, instrument_id, signed_qty, avg_cost, cost_basis_quality, revision, computed_at | Rebuildable current holdings |
| `cash_projections` | account_id, currency, balance, revision, computed_at | Rebuildable cash by currency |
| `portfolio_snapshots` | id, as_of, recorded_at, revision, valuation_policy_id, base_currency, total_nav, completeness | Historical valuations, not the same as baselines |
| `snapshot_positions` | snapshot_id, account_id, instrument_id, qty, mark, market_value, pnl, quote_id, quality | Per-position valuation evidence |
| `market_quotes` | id, instrument_id, provider, as_of, received_at, session, bid, ask, last, mark, delayed, quality | Timestamped quotes; no fake live prices |
| `price_bars` | instrument_id, provider, interval, start_ts, open, high, low, close, volume, adjusted, revision | Historical OHLCV |
| `fx_rates` | base, quote, as_of, provider, rate, quality | Explicit FX conversion provenance |
| `option_snapshots` | instrument_id, as_of, provider, bid, ask, last, volume, open_interest, iv, delta, gamma, theta, vega, underlying_price, status | Option chain/Greek evidence |
| `watchlists` / `watchlist_items` | list, instrument, reason, tags, settings | Additional observed assets |
| `watch_rules` | id, subject, rule_type, params, schedule, enabled | Alert triggers |
| `companies` | id, symbol, CIK, name, sector, industry | Link tickers to issuers |
| `source_documents` | id, company_id, type, url/path, published_at, observed_at, hash, revision, provenance | Filings/news/reports/IR original source |
| `document_chunks` | document_id, chunk_index, text, page, embedding nullable, version | Cited search and comparisons |
| `company_facts` | company_id, metric, period, value, unit, reported_at, available_at, document_id, version | Point-in-time fundamentals |
| `research_findings` | fact_id / document_id, claim, confidence, valid_from, supersedes_id | Track what changed |
| `signals` | id, strategy_code, instrument_id, generated_at, status, score, evidence JSONB, quote_refs, model/rules_version | Immutable generated opportunity signal |
| `trade_plans` | signal_id, trigger, sizing, stop, targets, entry/exit rules, estimated costs, risk, expiry_at | A plan, not a broker order |
| `signal_events` | signal_id, event_type, event_at, evidence, outcome | Lifecycle and forward validation |
| `executions` | id, account_id, instrument_id, qty, price, fees, effective_at, linked_signal_id nullable | **Self-reported** actual trades; may be represented by portfolio events |
| `chat_sessions` / `chat_messages` | role, canonical content/tool items, stable item IDs, timestamp, tool references, provenance | Provider-neutral conversational history, not source of financial truth |
| `agent_runs` / `tool_calls` | initiator, objective, status, provider, model, analysis_mode, mode_policy_version, effective_limits, analysis_completeness, limit_reasons, parent_run_id nullable, adapter/prompt/schema versions, input refs, portfolio revision, reported usage, estimated cost and price version, latency, sanitized request ID, error, provider-state reference | Agent reproducibility and bounded provider calls; credentials never persisted |
| `job_runs` / `alerts` | schedule, started_at, ended_at, status, dedup_key, source_signal | Monitoring operations |

Scheduled AI job configuration stores its selected analysis mode explicitly; each run captures the resolved policy version and effective limits. Changing the chat default does not change existing schedules. See `15_ANALYSIS_MODES.md`.

Add indexes on `account_id`, `instrument_id`, `as_of DESC`, `effective_at`, `source hash`, `signal status`; use DB uniqueness for natural instrument keys where possible. All changes include recorded_at and effective_at for audit and replay. Avoid JSON-only design for core portfolio math.

Provider continuation can be stored with the run as adapter-private JSONB or a private referenced record, scoped by provider/model/adapter version and the last acknowledged canonical item ID. It preserves required native continuation metadata without making it part of the portfolio schema or public API. No API keys, authorization headers, ChatGPT credentials or browser cookies are stored. See `14_LLM_PROVIDERS.md`.

## 2. Absolute current state and history
Current state is built from **latest confirmed `portfolio_baseline`** and incremental `portfolio_events` after its reset boundary. Old baselines, events and snapshots remain queryable as historical record. A later full replacement does **not** create inferred buys/sells and does not reapply earlier events.

### Replay boundaries
- Every baseline has monotonic `revision` and confirmation timestamp. Projection uses exactly the baseline and confirmed incremental events attached to that revision, ordered by effective_at + recorded_at + deterministic ID tie-breaker.
- After a new baseline is confirmed, future events attach to the new revision.
- Backdated events before latest baseline effective time cannot silently alter current state; present a corrective workflow or record as historical note only.
- Duplicate `idempotency_key` is ignored/refused rather than replayed twice.
- Concurrent preview confirmation rejected when expected portfolio revision differs from current one.
- `restoreSnapshot` creates a **new** baseline equal to a chosen historic state, does not erase later events.

## 3. Quantity, cash and options
- Signed position quantity: long positive, short negative. Stocks in shares, options in contracts.
- For standard US listed equity options `multiplier=100`, but read from instrument metadata and support adjusted/nonstandard deliverables. Never assume all options are standard.
- Buy shares: increase long qty and reduce matching currency cash by shares*fill + fees. Sell shares: decrease long qty and increase cash by proceeds - fees. Short sales are explicit operations, not an accidental negative balance.
- Sell-to-open call/put: quantity -= contracts and cash += premium*multiplier - fees. Buy-to-close: quantity += contracts and cash -= debit*multiplier + fees.
- Long option marks contribute positive market value; short options contribute **negative** market value. Premium received affects cash but is not instantaneous net-account profit.
- Exercise/assignment must modify options, underlying holdings and cash atomically using actual contract deliverable, with verified fees and direction.
- Expiration requires explicit time/status with an exercise/assignment confirmation policy; never automatically assume expiring ITM options disappear harmlessly.
- Covered calls: identify matched shares/short call obligations at a strategy view, without netting away positions or assuming hedge when insufficient shares.

## 4. Money/FX and valuation
- Postgres `NUMERIC`, JavaScript decimal library; no binary float for money or option strike math. Rounding only at display/report boundaries.
- `market_value_native = signed_qty * price * multiplier` (multiplier=1 for stock), `NAV = sum(native market_values converted to base currency at timestamped FX) + sum(cash FX-converted) - explicit liabilities`.
- Mark policy configurable (e.g., valid bid/ask midpoint where both valid, conservative liquidation sensitivity; fallback last/EOD visibly labeled). Do not silently mix quote sessions.
- Show per-position valuation timestamp and status; whole portfolio valuation stamped as mixed/stale when constituent data dates differ materially.
- Cost basis from imported average cost may be incomplete. Do not invent historical purchase dates or fees.

## 5. Realized/unrealized returns
- Baseline import may include only avg cost and quantity: create qualified opening pseudo-lot and label pre-baseline realized P&L **unknown**.
- For confirmed post-baseline transactions, calculate realized P&L per documented FIFO or average-cost mode (configurable, default average-cost for display; tax reporting explicitly not supported), in native instrument currency.
- Preserve lot-level fee allocation and short-option premiums. Distinguish `data_quality=COMPLETE_LEDGER/BASELINE_ESTIMATE/UNKNOWN`.
- Snapshot-to-snapshot NAV change is **not** investment return when deposits, transfers, FX and distributions are untracked.
- TWR requires dated external cash flows and quality checks; XIRR requires valid dated flow endpoints. Otherwise show NAV change and 'return not reliable'.

## 6. Examples
- 100 TSLA shares @ 400, sell 1 covered call @ 6: cash +600 minus fees, call quantity -1, call liability at mark; portfolio must not show instant $600 profit.
- Excel baseline contains 0 IBIT shares and no option rows: current quantities become zero after confirm, but no realized gain or sale is fabricated.
- Broker/account labels repeat across different accounts: use unique account_key and ID, never ticker+account_type alone.

## Implemented M4 research schema

Migration 0014 adds research_companies, source_documents, document_chunks, company_facts, research_findings and research_imports. Original bytes and source revisions remain immutable. Availability is conservatively the first observation or known later publication time; parent document availability gates facts, passages and quoted claims. See [ERD](ERD.md) and [research semantics](M4_RESEARCH.md).
