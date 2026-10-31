# 08 — Autonomous Monitoring and User Interface

## 1. Worker jobs and cadences
User-editable schedules; examples, not hardcoded guarantees:
- `portfolio.revalue`: every 5 minutes during eligible regular U.S. market hours; less often outside hours.
- `portfolio.risk-watch`: after any confirmed portfolio change and after material new quote/option data, minimum debounce.
- `options.expiry-watch`: daily, plus higher priority near expiry and ex-dividend dates.
- `watchlist.scan`: every 5–15 minutes during liquid eligible session, subject to data plan and rate budget.
- `universe.discovery`: every 30–60 minutes where data license supports, starting with bounded liquid universe; end-of-day fallback.
- `research.sec-check`: daily / intraday where supported; `news.check`: schedule per plan and budget.
- `signal.track`: recurring; evaluate stored trigger/exit rules against timestamp-matched fresh observations.
- `daily.review`: premarket and end-of-day portfolio decision brief.
- `weekly.performance`: outcomes, risk, costs and model/scanner evaluations.

Use `pg-boss` persisted schedules with dedup keys, locks, job timeouts, retries and last-success timestamps; after workstation sleep/restart, mark missed intervals; catch up only where informative, never pretend intraday monitoring ran during offline time.

Each AI-enabled job has an explicit Quick/Standard/Extensive setting, captured when configured. Mode never changes a schedule's cadence or bypasses daily cost limits. Deterministic risk alerts do not wait for a longer LLM run. Show examined scope and limited/unfinished coverage; never label a timed-out scan as a completed no-signal scan.

## 2. Alert severity and dedup
- `CRITICAL`: imminent significant risk (e.g., dangerous option expiry/exercise exposure, missing reliable risk mark in materially leveraged position), requiring attention.
- `ACTIONABLE`: valid new trigger with fresh aligned quotes, sized plan and explicit stop/invalidation.
- `INFORMATIONAL`: earnings change, guide revision, observation, new watchlist event.
- `DATA_WARNING`: feed stale, ingestion failed, research unavailable, workbook incomplete.

Include ticker, account, event, exact timestamp/market session, key values, suggested next action and primary risk. Group and suppress repeats until materially changed or defined cooldown expires. Source-based evidence always attached. Do not repeatedly flag passive distant limit ideas as imminent danger.

## 3. Web navigation and screen design
### Dashboard (home)
- Top status: market session (NY time), data provider status / last refresh, latest portfolio revision, active alerts, automation online/offline.
- KPI tiles: NAV in base currency (plus native cash), daily change and reference timestamp, realized/unrealized P&L coverage, gross/net delta exposure, concentrated names, options expiring soon.
- Main: NAV history, allocations/account grid, current actionable alerts, watchlist movers, soonest option expirations.
- Quick actions: `Ask M²D`, `Record Trade`, `Upload Excel`, `Run Scan`.

### Portfolio
- Hierarchical grid Account -> Symbol -> Leg/lot; columns qty, cost, mark, P&L, exposures, quote freshness.
- Cash balances by currency/account. Historical snapshots, change log and baseline restore. Filter/search/export.

### Options & Risk
- Expiration calendar; contracts with sign/strike/call-put/quantity; Greeks; coverage/collateral; defined-risk payoff chart and scenarios; position-specific exit/roll comparisons.

### Market / Watchlist
- Candlesticks/volume, indicators, news/catalyst timeline, filings comparisons, custom screening rules. Display data timestamps.

### Opportunities
- Sorted signals with status, candidate type, score, catalyst, entry, stop, target, R:R, estimated costs, watchlist/held badges, primary risk. Drill-down plan and evidence.

### Research
- Companies, financial metric history, documents, claims and revisions, ingestion health; side-by-side diff, original evidence citation.

### Trade Journal / Performance
- Confirmed local transactions, notes, matching AI signals, realized P&L quality, portfolio performance limitations, signal outcomes/benchmark and backtest versions.

### Chat
- Streaming answers with inline actionable cards, source links, "Preview Portfolio Change" cards, confirm/reject actions, cited numbers, context-account picker, conversation search.
- Place **Quick / Standard / Extensive** beside the input; Standard is the initial default. Save a personal-workspace default and allow a per-request override. The same selector is available for manual scans/research. Show short depth/cost hints, the mode on each answer, progress and Cancel; do not promise fixed completion times or dollar costs.
- Lead with a compact conclusion, action/trigger when warranted, key evidence and primary risk in every mode. Extensive adds expandable evidence, counter-thesis and scenarios. A "Run deeper" action explicitly starts a new run in the chosen mode and shows its scope; no automatic escalation or provider/model change.
- Display the active provider/model and clear unavailable, refused, incomplete or budget-exhausted states. Setup directs the owner to server environment configuration; no ChatGPT sign-in button or browser API-key storage. Provider-native continuation is never displayed.

## 4. Frontend rules
- Responsive desktop-first terminal, dark/light themes.
- Color semantics accessible; never rely on green/red alone for gain/loss.
- Chart price/session provenance visible on hover; account chart aggregates use aligned timestamps or explicitly annotate stale input.
- Every editing/import operation goes through preview/diff and confirmation.
- Show explicit `NO_SIGNAL` instead of generating fake opportunities.
