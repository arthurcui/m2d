# 07 — Risk, Trading Strategies, Signals and Performance

## 1. Investment decision priority
1. Stop deterioration in existing positions and concentrated exposures.
2. Preserve cash/option obligations; detect approaching expirations, assignment and gap risks.
3. Identify actionable entry/exit/roll/hedge candidates in existing holdings and watchlist.
4. Explore new liquid names with clear catalysts and favorable risk/reward.

## 2. Risk Engine
### Deterministic baseline
- Equity per-account and consolidated exposure, native/base currency; symbol, sector, correlated groups.
- Net option delta exposure (option signed contracts * contract multiplier * current delta) and combined underlying-equivalent delta exposure.
- Gross exposure and short-option notional; do **not** confuse these with broker-specific buying power requirements.
- Concentration thresholds, cash liquidity by currency, dividend/earnings gap exposure, near-expiry obligations.
- Scenario P&L for underlying shocks (-20/-10/-5/+5/+10/+20%) using direct repricing if supported, or clearly labeled first/second-order Greeks estimates with validity caveat.
- Max profit, max loss, break-even, payoff-at-expiry for supported defined-risk strategies; undefined-risk positions explicitly identified.

### Option strategies (incremental)
Phase A: long stocks, covered calls, cash-secured puts (cash check), long call/put, vertical debit/credit spreads.
Phase B: protective puts, collars, rolling single options, diagonals/calendars; appropriate intermediate mark-to-market estimation.
Always account for contract deliverables, stock coverage, short option obligations, slippage, bid/ask, fees, dividend/exercise/early-assignment risks, liquidity and account type constraints when known. Do not label a naked short as covered.

## 3. Candidate generation and qualification
`Universe -> facts/features -> technical + catalyst filters -> strategy template -> objective risk evaluation -> evidence/data freshness checks -> ranked candidate -> signal`.
Possible features: trend vs 20/50/200-day average, ATR/realized vol, relative volume, recent earnings/guidance, liquidity, spread percentage, option IV percentile **only with sufficient historical IV**, open interest, calendar catalysts, sector correlation, existing position exposure.

Initial configurable score (0–100) is a **screening heuristic**, not estimated probability:
- Opportunity/catalyst: 25
- Trend and technical setup: 20
- Liquidity/execution feasibility: 20
- Risk/reward and defined exit: 20
- Portfolio fit/diversification: 15

Default `qualified` score threshold example 75, but score alone cannot override fatal risk/data checks. All thresholds config-driven with documented testing; no claim of statistically proven edge until validated.

## 4. Required trade-plan object
```json
{
  "ticker": "TSLA",
  "strategy": "COVERED_CALL",
  "action": "SELL_TO_OPEN",
  "accountKey": "Questrade_RRSP",
  "status": "WATCH_ONLY",
  "asOf": "2026-10-30T20:00:00Z",
  "quoteSession": "REGULAR",
  "entryTrigger": {"type":"LIMIT_AND_CONDITION", "condition":"example only", "price":"0.00"},
  "instrumentLegs": [{"optionRight":"CALL", "expiry":"2026-11-20", "strike":"0.00", "qty":"-1"}],
  "positionSize": {"contracts":"1", "capitalAtRisk":"UNKNOWN"},
  "stopOrInvalidation": "defined condition",
  "targets": ["defined exit or profit target"],
  "estimatedFees": "0.00",
  "estimatedSlippage": "UNKNOWN",
  "riskRewardRatio": null,
  "mainRisk": "Gap down in stock; limited upside and assignment risk",
  "citations": [],
  "limitations": ["Illustrative values only; not an executable trade"]
}
```
This is a **schema example**, not a real trade. For option spreads include leg-level bid/ask/mark and net credit/debit; for stock trades include share qty, max-dollar risk and invalidation. Unknown values are NULL/UNKNOWN, never 0.00 substituted in live plans.

## 5. Signal lifecycle and non-spam
`DISCOVERED -> QUALIFIED -> ARMED -> TRIGGERED -> ACTIVE -> CLOSED`, with side branches `INVALIDATED`, `EXPIRED`, `REJECTED`, `WATCH_ONLY`.
- Only `TRIGGERED` with fresh data and full plan is labeled actionable.
- `ACTIVE` is actual self-reported position or monitored hypothetical plan (explicit `execution_mode`); not broker execution.
- Store each transition with timestamp + evidence. Dedup by `(ticker, strategy, trigger fingerprint, source condition, review interval)`.
- Retire/mutate only via new version/event; signals retain original entry rule to prevent hindsight edits.

## 6. Portfolio-aware position sizing
- Use user-defined max total risk, per-trade risk budget, per-symbol exposure, sector exposure, option contract coverage, and downside gap tolerance.
- Compute `max_units = floor(risk_budget_dollars / risk_per_unit)` where risk is meaningfully bounded. For unbounded or uncertain option strategies, mark sizing as requiring manual discretionary decision and no automatic actionable quantity.
- If account cash/collateral availability is unknown or user has not updated holdings recently, lower confidence / inhibit executable status.

## 7. Exit and rolling plans
Store initial trade thesis, invalidation, time stop, profit-taking targets, expiry risk, catalysts, volatility assumptions, and planned review cadence. Evaluate `HOLD / TRIM / CLOSE / ROLL / HEDGE` under explicit comparative scenarios. A roll is closing old exposure + opening new exposure with net incremental P&L/credits; never call it a free extension of time.

## 8. Honest performance evaluation
- Separate `AI_SIGNAL`, `SIMULATED_FILL`, `USER_REPORTED_ACTUAL_FILL`, and `MARKED_POSITION`.
- Backtesting includes fees, spreads, realistic fill assumptions, dividends/splits, delisted assets where available, and a point-in-time data gate.
- Avoid using future data, revised earnings facts, unadjusted contracts across splits, and hindsight selection of exits.
- Report sample size, conditional probability estimates with intervals when statistically valid, expectancy, profit factor, annualized volatility/drawdown where enough data, benchmark comparisons and out-of-sample results.
- No guarantee of profitability; a strategy with insufficient observations stays `UNVALIDATED`.
