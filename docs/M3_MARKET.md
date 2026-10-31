# M3 — Market data and valuation

M3 adds indicative market evidence and valuation to the M1 ledger and M2 Agent. It does not add research, recommendations, trading, monitoring schedules, or performance reconstruction.

## Local operation

Keep existing `.env` and database volumes. Defaults remain offline:

```dotenv
MARKET_PROVIDER=fixture
BASE_CURRENCY=USD
TWELVE_DATA_API_KEY=
MARKET_DELAY_MINUTES=
```

```powershell
docker compose up --build --detach --wait --wait-timeout 180
```

Open `/market`. Refresh a quote, hourly chart, or the example TSLA 2026-12-18 option snapshot. The fixture uses fixed **synthetic** October 30, 2026 observations; refreshing does not move their as-of timestamps forward. Supported fixture equity symbols are TSLA, NVDA, AAPL, CRWV, SPY, IBIT, TSLL and OPEN, in USD. FX examples are CAD/USD and USD/CAD. Other instruments remain unavailable. Fixture Greeks and IV are intentionally absent.

Portfolio and Dashboard include valuation coverage. **Refresh portfolio prices** explicitly refreshes up to 50 distinct source requests. It never changes holdings, cash or portfolio revision. **Save valuation snapshot** preserves the current valuation, source observation IDs and portfolio revision. Stored valuations are observations, not investment returns. Agent can read stored valuation without fetching paid data or replacing a user-reported trade price.

## Optional Twelve Data configuration

Set these values in the backend `.env`, then recreate the containers:

```dotenv
MARKET_PROVIDER=twelvedata
TWELVE_DATA_API_KEY=your-server-side-key
MARKET_DELAY_MINUTES=
```

The key is independent of `OPENAI_API_KEY`, is never exposed to browser code, and is not needed in fixture mode. Set delay minutes only when known from your data entitlement. Blank means **unknown**, not zero. A configured key does not establish that the subscription covers a particular instrument or request.

This adapter supports unambiguous NASDAQ/NYSE/AMEX equity quotes, unadjusted hourly OHLCV bars, and explicit FX pairs. It uses regular-session quotes (`prepost=false`); a regular close is never relabeled as a current after-hours price. Instrument exchange and currency must match the provider response. Ambiguous imported exchange labels are not guessed. Equity bars include their exchange and currency, and omit unfinished hourly intervals. FX numeric JSON tokens are preserved as decimal strings using Node 24's JSON reviver source context.

**Licensed option prices/chains/Greeks are unavailable in this real adapter.** Option holdings remain unpriced; stock/FX refreshes can proceed independently. The provider-neutral options contract and fixture snapshot exercise the missing-Greeks path. No provider or fixture fallback occurs after a missing key, quota error, unsupported identity, or provider outage.

Requests are user-triggered, globally serialized with a PostgreSQL advisory lock, and rate-limited to one attempt per eight seconds. Provider failures impose a one-minute cooldown across API restarts. No automatic retries, scanning, broad universe discovery, or hidden paid requests run. Read-only navigation and Agent tools only use cached data. Multiple browser refreshes can receive `MARKET_BUSY` or `MARKET_RATE_LIMIT`; retry later. If the API stops during a refresh, startup marks the unfinished request interrupted rather than silently repeating the external call.

Provider reference: [Twelve Data REST documentation](https://twelvedata.com/docs). Consult the provider for your current coverage and license; the implementation makes no real-time entitlement assumption.

## Valuation and provenance

- All money remains decimal strings; valuation uses decimal.js with 120-digit working precision. SVG chart coordinates alone use JavaScript numbers.
- Match the entire portfolio instrument key, including exchange, currency and exact option terms. Options contribute signed quantity × mark × multiplier; a short option is a liability.
- Prefer a validated bid/ask midpoint; otherwise use the explicitly labeled last/regular-close value. Crossed quotes, future observations and malformed data are rejected. Stale and delayed values may support **indicative** valuation, never execution signals.
- Convert native amounts using an explicit, timestamped FX pair. Do not assume USD/CAD parity or synthesize missing cross rates. Missing prices or FX make total NAV null; the known subtotal is labeled incomplete, including when an omitted position could be a liability.
- Per-position unrealized P&L uses recorded unit cost. Missing cost remains unknown; imported basis stays an estimate. Native-currency values, account totals, price timestamps, mixed timestamps, source quality, and missing coverage remain visible in the returned valuation. Pre-baseline realized P&L, historical returns and tax basis are not reconstructed. Existing recorded realized events remain in portfolio history.
- All M3 evidence is `WATCH_ONLY`. Regular quotes older than 90 seconds are marked stale. Delayed, closed, unknown-quality and fixture values cannot become actionable signals.
- Exchange sessions use New York DST plus the published 2026–2027 NYSE equity holidays and early closes. Outside calendar coverage, session is `UNKNOWN`; no future trading calendar is invented. Early-close extended sessions end at 17:00 Eastern in this conservative model. [NYSE calendar source](https://www.nyse.com/trade/hours-calendars).

## Persistence and contracts

Additive migration **0008** creates `market_observations`, `market_refreshes`, and `valuation_snapshots`. Existing ledger tables/data are unchanged. The generated Drizzle snapshot and `ERD.md` belong with the migration.

Market observations retain raw provider response text (or deterministic fixture evidence) plus validated typed quote/bar/FX/options envelopes, indexed provider/kind/subject/as-of and separate received/available timestamps. Content hashes deduplicate identical evidence; refresh keys deduplicate requests. Revisions never overwrite prior observations. Reads select only observations available at the requested point in time. Failed parsing does not replace last-good evidence. Public responses exclude raw payloads and credentials. See ADR-036.

Version 1 endpoints:

| Endpoint                                                      | Behavior                                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /market/status`                                          | Provider configuration, current session, options coverage and recent refresh results; no network calls |
| `GET /market/quotes?symbol=TSLA&exchange=NASDAQ&currency=USD` | Stored equity quote and current freshness                                                              |
| `GET /market/bars/TSLA?exchange=NASDAQ`                       | Stored unadjusted hourly OHLCV                                                                         |
| `GET /market/options/TSLA?expiry=2026-12-18`                  | Stored option snapshot, nullable Greeks/IV                                                             |
| `GET /market/fx?base=CAD&quote=USD`                           | Stored explicit FX direction                                                                           |
| `POST /market/refresh`                                        | `{version:1,idempotencyKey:UUID,request}`; request kind is quote/bars/fx/options                       |
| `GET /portfolio/valuation`                                    | Current revision, valuation quality, exact evidence and missing coverage                               |
| `POST /market/snapshots`                                      | `{version:1,idempotencyKey:UUID}`; save indicative valuation without changing financial state          |
| `GET /market/snapshots`                                       | Most recent 100 valuations for the configured provider                                                 |

Quote refresh requests include the full existing instrument definition. Bars take symbol and optional exchange (default NASDAQ), options take underlying symbol/expiry, FX takes base/quote. Routes are beneath `/api/v1`. Browser writes use the same-origin application proxy.

## Verification

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm docs:erd:check
$env:TEST_DATABASE_URL='postgresql://m2d:test-only@127.0.0.1:55433/m2d_test'
pnpm test:integration
```

Integration tests create and drop only their own temporary databases. Browser tests must target a fresh disposable Compose project with `MARKET_PROVIDER=fixture`, `LLM_PROVIDER=fixture`, a distinct `WEB_PORT`, separate upload directories, and `E2E_ALLOW_PORTFOLIO_WRITES=1`. Never run write-enabled E2E against the real portfolio.

Live provider verification is optional and was not performed for M3; mocked transports cover response normalization, identity mismatches, missing keys, absent options entitlement, errors and throttling. Automated schedules remain M6, research M4, and risk planning M5.

### Completed verification — 2026-10-31

- 115 offline unit tests, 29 PostgreSQL integration tests and all 19 browser tests passed.
- Formatting, lint, strict typecheck, ERD freshness and Docker Compose validation passed. API, worker and Next.js production images built successfully; all services became healthy.
- The full browser suite ran against fresh isolated fixture databases. Desktop/browser flows and a narrow-screen screenshot were checked, including Agent valuation, quote/chart/options provenance, snapshot saving and existing portfolio confirmations.
- Integration verification exposed and fixed a pre-existing chat completion race: terminal status and the final event now commit atomically. Interrupted market refresh recovery and zero foreign-currency cash balances also have regression coverage.
- The local app was updated using the tested images and additive migration. Its confirmed portfolio revision remained 8 before and after deployment. No real portfolio changes, live market-provider calls or paid inference were performed by this work.
