# 01 — Product Requirements (PRD)

## 1. Product and user
- Brand: **M²D** — Move · Motive · Decision.
- Tagline: **See the Move. Understand the Motive. Make the Decision.**
- One owner, no other logins/users. Primary markets: U.S. stocks, ETFs and listed equity options. Account labels may include IBKR Margin, IBKR RRSP, Questrade TFSA, Questrade RRSP and arbitrary user-defined accounts. No connection to those brokers.
- Language: English-first interface with Chinese/English conversational commands and summaries; number, currency and market time formatting explicit.
- Outcome: support repeatable trades with positive risk-adjusted expectancy after fees/slippage, avoid unnecessary drawdown, recognize when no trade is justified.

## 2. Core user stories
### Portfolio bookkeeping
1. Create accounts with name, institution label, type (CASH/MARGIN/RRSP/TFSA/etc.), base currency and notes.
2. Enter natural-language instructions: buy/sell stock, buy-to-open/sell-to-open options, buy-to-close/sell-to-close, cash adjustment, transfer, fee, dividend, option expiration/assignment/exercise, manual correction. System parses, previews exact consequences and awaits confirmation.
3. Upload an Excel workbook representing **all** current accounts/positions/cash and atomically replace the current baseline after preview. Prior history is never deleted.
4. Query positions consolidated across accounts, per-account holdings, cash by currency, effective cost basis, option expiration calendar and data freshness.
5. Correct mistakes with an audited correction/reversal, not a silent rewrite.

### Market/research
6. Auto-fetch price/volume bars, quote bid/ask/last, option chains/Greeks/IV/open interest where licensed and available, FX, company fundamentals, SEC filings and pertinent news.
7. Upload PDF reports, transcripts, articles, and Excel research; extract structured facts with source URLs/page anchors, publication timestamps, revisions and uncertainty.
8. Track how company theses, analyst assumptions and source facts change. Identify genuinely new information.

### AI conversation and dashboards
9. Ask "What's the most actionable thing to do with my holdings?", "Which covered calls should I consider?", "What caused this drawdown?", "Why did ticker X move?" and receive cited, timestamped responses grounded in local portfolio and retrieved data.
10. Access portfolio, market, positions/options, opportunity, risk, research, signal journal and performance dashboards. Tables should drill into underlying evidence.
    Choose Quick, Standard or Extensive analysis for each question or manual scan, with Standard as the initial default and a saved personal-workspace preference. Modes control depth and resource use while preserving all financial/data checks; see `15_ANALYSIS_MODES.md`.

### Monitoring and decision support
11. Schedule portfolio/watchlist/universe scans; monitor earnings, price/volume changes, options expiry, Greeks, important filing/news changes, and concentration/margin proxies.
12. Rank candidate opportunities and show entry trigger, sizing, stop/invalidation, profit targets, options contracts, costs, risk-reward and main contrary thesis.
13. Track the full recommendation lifecycle; compare **proposed** vs **actual self-reported** execution; monitor exit plans.
14. Inhibit actionable status if quotes are stale, strategy risks are not computable, or required data is missing; clearly indicate monitoring-only output.

## 3. Explicitly out of scope
- Multi-tenant or user registration, account brokerage OAuth/API, live orders, automatic execution, subscriptions, social trading, tax filing, high-frequency execution, broker-grade real-time order routing.
- Never imply background tasks execute while Docker/services are off; display last successful scan and missed schedule status.
- A claim of guaranteed profit or adaptive AI learning without out-of-sample checks.

## 4. Definition of success
- Accurate per-account/currency position state from imported snapshots and confirmed changes.
- Portfolio and option calculations pass reconciled fixture tests, including short options and assignments.
- All AI-visible numerical claims trace back to DB calculation or timestamped external data.
- New actionable signals have full plans, risk filters, unique identity, and forward outcome tracking.
- Every alert tied to a new material condition; no noisy repeated reports.
- The system starts with `docker compose up --build` and can be restarted without duplicating imports/jobs.

## 5. Evaluation metrics
**Portfolio:** net asset value (NAV), realized/unrealized P&L by account/asset/currency, total/net delta exposure, drawdown (where evidence supports it), concentration, open option obligations, available cash.
**Signals:** count qualified/triggered/invalidated, realized/mark-to-market simulated return by rule, expectancy, profit factor, win rate, median return, time-to-trigger, false positive rate, max adverse excursion, slippage/fees.
**Comparison:** SPY or another selected benchmark with dividends/FX methodology stated; time-weighted return only with sufficiently complete cash flows, otherwise label performance unknown/approximate.

## 6. Decision principles
- A no-trade conclusion is legitimate; never manufacture signals to fill a quota.
- Prioritize holdings and highly liquid watchlist instruments before broad market opportunity discovery.
- Distinguish observation, hypothesis, trade plan, triggered order candidate, and actual trade.
- Portfolio actions require human confirmation; no broker connection exists.
