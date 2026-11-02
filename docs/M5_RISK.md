# M5 — Stocks, ETFs, options risk and trade planning

M5 adds a deterministic risk package, a Trade Planner workspace, bounded Advisor tools and saved hypothetical plans. Stocks and ETFs are first-class: proposed purchases, sales of owned shares, stop-based sizing and before/after downside scenarios are available without an option position.

## User workflow

- **Portfolio Risk** shows marked gross/net exposure, native-currency concentration, consolidated base-currency exposure using stored FX, per-position delta-equivalent shares, short-option strike notional and expiry days. Missing marks/FX/Greeks remain unknown. Cached market evidence retains provider, session, timestamp, delay and quality. Refresh risk reads cached evidence; use portfolio price refresh to fetch new prices.
- **Plan a Trade → Stock / ETF** analyzes a hypothetical buy or sale in an account. A sale reduces recorded long shares and computes estimated proceeds and remaining exposure; it never silently opens a short. Enter price, fees, optional stop/target and risk budget. Stop-based sizing assumes a fill at the stop and can underestimate gap losses. Cost-based sale profit retains the recorded cost-quality limitation and is not tax accounting.
- **Plan a Trade → Option strategies** supports stocks/ETFs, covered calls, cash-secured puts, long calls/puts and same-expiry vertical debit/credit spreads. Enter explicit prices, quantities and costs. The payoff chart is at option expiry, not a current option valuation; stock charts show hypothetical P&L by share price. Missing slippage is flagged and never silently regarded as known zero. Standard 100-share contracts only; calendars/diagonals, adjusted contracts, rolls and other Phase B strategies remain unsupported.
- **Build a reviewable trade plan** requires entry, exit, invalidation and main risk. Preview against current portfolio revision, then explicitly save. Stock plans distinguish BUY from SELL; a sale plan assesses remaining exposure and reports proceeds separately. Saved plans retain immutable inputs, evidence and assessment timestamps. They do not reserve funds, execute orders or change portfolio holdings. Old plans are historical assessments, not current recommendations.
- **Discuss with Advisor** prepares an editable question in the independent Trade Planner conversation. Advisor calls the same deterministic calculators as the UI. Risk conversations cannot invoke portfolio-change previews, even if a model attempts it. Report actual trades through Portfolio.

The workspace has three tabs: Portfolio Risk, Plan a Trade and Saved Plans. Plan a Trade starts from an existing holding or a new ticker, without requiring a watchlist entry. Use portfolio selection explicitly carries a selected account/holding into the draft; subsequent navigation preserves the draft. The Advisor receives the selected account/holding and Discuss with Advisor includes the proposed ticker, strategy and inputs. Changing inputs clears stale calculations and previews. `/risk` and its stored conversation ID remain unchanged for compatibility.

## Calculation and data boundaries

All money, position and contract arithmetic uses decimal.js with explicit decimal strings. Payoff extrema and roots are computed at piecewise-linear breakpoints and the infinite-price slope. Stock/ETF scenarios apply -20/-10/-5/+5/+10/+20 percent shocks. Option scenarios use a labelled first-order delta approximation only when aligned, fresh option and underlying inputs exist; missing inputs remain unknown. Large shocks, changing IV, time decay, dividends, early exercise and assignment can invalidate an approximation. Expiry payoff and mark-to-market stress are different calculations.

Coverage allocates same-account, same-currency stock shares or cash in earliest-expiry order and never reuses resources across obligations or accounts. Long options are not treated as shares or cash: a spread can be defined-risk without being share-covered. Coverage is not broker margin/buying power or a statement of account permissions. Proposed option plans include existing obligations and hypothetical debit/cost requirements. Covered-call stock prices are payoff reference prices, not an implicit purchase of extra coverage.

Concentration defaults to flagging more than 25% of known gross native-currency marked exposure. Incomplete marks make percentages partial. Sector, correlated-group and dividend/earnings-calendar inputs are explicitly unknown where the existing providers do not supply them; they are not inferred from ticker names. Missing FX blocks complete base-currency totals. FX is used only for reporting; no foreign-exchange trading is added.

Plans remain **WATCH_ONLY**, never actionable. The validator identifies missing/stale/delayed/non-regular/EOD quotes, missing bid/ask or spreads above 5%, missing slippage/budgets, inadequate cash or option coverage, exceeded risk budgets, expired contracts and unreviewed holdings. Account permissions, calendar events and execution conditions require manual review. M6 trigger/scanner/monitoring functionality is not implemented. A payoff break-even is not automatically a stop; reaching a covered-call profit cap is not thesis invalidation.

Deployment thresholds are configurable with `RISK_CONCENTRATION_PERCENT` (25), `RISK_MAX_SPREAD_PERCENT` (5) and `RISK_NEAR_EXPIRY_DAYS` (14); each assessment retains the effective thresholds. Selling shares also reassesses coverage of existing short calls.

## Contracts and storage

- `GET /api/v1/risk/summary`: current self-reported portfolio risk and evidence.
- `POST /api/v1/risk/scenarios`: version 1, fixed bounded shock set.
- `POST /api/v1/risk/stock-trade`: version 1 hypothetical stock/ETF buy or sale.
- `POST /api/v1/strategies/evaluate`: version 1 typed strategy payoff.
- `POST /api/v1/risk/plans/preview`: deterministic preview; no persistence.
- `POST /api/v1/risk/plans`: UUID idempotency key, portfolio revision and required plan fields; immutable save with revision guard.
- `GET /api/v1/risk/plans`: latest 100 saved plans.

Advisor tools: `risk_summary_read_v1`, `stock_trade_evaluate_v1`, `strategy_evaluate_v1`, `trade_plan_preview_v1`. Load an Advisor draft into the planner to review its inputs and explicitly save it. Models cannot save plans, run SQL or commit financial state. Normal per-send budgets/cancellation/provider boundaries apply.

Migration 0022 adds `trade_plans` with unique request identities, nonnegative portfolio revision and WATCH_ONLY constraint. Saves are transactional; conflicting retries fail, identical retries reuse the original plan. The ERD is regenerated. No existing portfolio or evidence history is rewritten.

## Running and verification

```powershell
pnpm install --frozen-lockfile
pnpm test
# TEST_DATABASE_URL must identify a disposable PostgreSQL/pgvector server
pnpm test:integration
pnpm typecheck
pnpm lint
pnpm format:check
pnpm docs:erd:check
docker compose up --build --detach --wait --wait-timeout 180
```

Open `/risk`. Fixture mode works without API keys. Bounded live verification uses public/synthetic inputs and the configured backend key only:

```powershell
pnpm --filter @m2d/api... build
node --env-file=.env scripts/evaluate-risk.mjs --live
```

The live script creates/drops its own database, checks hypothetical stock buying, selling existing shares and covered-call calculations, and asserts unchanged financial state. It is opt-in and never part of offline CI. Results and measured usage are saved under ignored `.tmp/`.

### Validation record (2026-11-01)

Offline validation: 212 unit tests, 57 PostgreSQL integration tests and 44 browser tests (including desktop/mobile risk workflows). Typecheck, lint, formatting, ERD consistency, Compose validation and isolated Docker build/startup checks passed.

Live OpenAI `gpt-5.4-mini-2026-03-17` verified stock buying, sales of owned shares, covered-call payoff and an unsaved structured plan draft using fictional accounts. The final three calculator checks used approximately USD 0.04992; the successful standalone draft used 19,059 input / 432 output tokens, approximately USD 0.01624. Total measured development verification including earlier/rejected attempts was approximately USD 0.23143. Estimates use configured evaluation rates, not a billing invoice. A live-discovered nullable-field error was fixed; a combined conversation hit its unchanged cost ceiling. The evaluator starts a separate draft conversation to keep context bounded; `--live --draft-only` verifies it alone. Financial state stayed unchanged.

Remaining limits: all plans are WATCH_ONLY; incomplete sector/correlation/events/Greeks remain explicit unknowns. Delta stress is a first-order estimate, not option repricing. Standard 100-share Phase A contracts only; no broker margin/permissions verification, order execution, Phase B strategies or M6 monitoring.

### Trade Planner usability pass

Renamed navigation and Advisor labels, combined planning into three tabs, and added explicit portfolio-selection handoff and unowned-ticker planning. Validation: 212 unit and 57 integration tests passed; all 45 browser cases were validated across the full suite and focused reruns after updating renamed control selectors. Strict types, lint, formatting, ERD and Docker checks passed. This pass changes the web workflow only; provider contracts and the previously live-verified inference path are unchanged.
