# M3 — Market data and valuation

M3 adds indicative market evidence and valuation to the M1 ledger and M2 Agent. It does not add research, recommendations, trading, monitoring schedules, or performance reconstruction.

## Local operation

Keep existing `.env` and database volumes. Defaults remain offline:

```dotenv
MARKET_PROVIDER=fixture
BASE_CURRENCY=USD
TWELVE_DATA_API_KEY=
MASSIVE_API_KEY=
MARKET_DELAY_MINUTES=
```

```powershell
docker compose up --build --detach --wait --wait-timeout 180
```

Open `/market`. Refresh a quote, hourly chart, or the example TSLA 2026-12-18 option snapshot. The fixture uses fixed **synthetic** October 30, 2026 observations; refreshing does not move their as-of timestamps forward. Supported fixture equity symbols are TSLA, NVDA, AAPL, CRWV, SPY, IBIT, TSLL and OPEN, in USD. FX examples are CAD/USD and USD/CAD. Other instruments remain unavailable. Fixture Greeks and IV are intentionally absent.

Portfolio and Dashboard include valuation coverage. **Refresh portfolio prices** explicitly refreshes up to 50 distinct source requests. It never changes holdings, cash or portfolio revision. **Save valuation snapshot** preserves the current valuation, source observation IDs and portfolio revision. Stored valuations are observations, not investment returns. Agent can read stored valuation without fetching paid data or replacing a user-reported trade price.

## Free Massive Basic configuration

For development, enable **Stocks Basic** and **Options Basic** in your Massive account. Put the key in the existing, ignored root `.env` (never in chat, source code, or the browser):

```dotenv
MARKET_PROVIDER=massive
MASSIVE_API_KEY=your-server-side-key
```

Recreate the stack with the local operation command above. The app stays in fixture mode until you explicitly select `massive`; neither this adapter nor an absent key causes a fallback. The Massive key is independent of the OpenAI key. This implementation stays on Basic endpoints even if the account has a paid plan.

- USD-denominated US stocks/ETFs: verified ticker identity, last completed trading day's **unadjusted close**, and up to 100 historical hourly bars. NASDAQ, NYSE, AMEX and ARCA listings are supported. Portfolio exchange `US` or imported `UNKNOWN` is accepted only after checking the exact ticker, USD currency and supported US listing against provider reference data. The quote retains the original portfolio instrument key and records `resolvedExchange` separately; the ledger is never rewritten. Explicit conflicting exchanges are rejected. An option with exchange `UNKNOWN` still requires exact standard-contract verification.
- Standard 100-share US equity/ETF options: fetch the **individual contract close** when refreshing portfolio prices. Confirm underlying, expiry, right, strike, multiplier and absence of adjusted deliverables against contract reference data first. An unrepresentable strike is rejected without rounding. No trade on the requested date means unavailable, never zero or a fabricated mark. Expired recorded holdings are not automatically removed.
- Equity reference types must match the recorded asset class: common shares/ADRs (`CS`/`ADRC`) for stocks, `ETF` for ETFs. Other security types or a stock/ETF conflict stay unpriced pending review; the app never substitutes a similarly named security. The Market page includes a Stock/ETF selector and quote reads accept optional `assetType` (default `STOCK`).
- Basic does **not** enable live quotes, bid/ask, chain snapshots, Greeks or FX in this adapter. The chain-refresh button is disabled; option holdings use individual quote requests. Non-USD balances remain unconverted and can make total NAV incomplete.
- Daily close `asOf` represents the **end of the reported New York calendar day**, not an exact last-trade timestamp. It is labeled `EOD_CLOSE`, `CLOSED`, `DELAYED`, `WATCH_ONLY`; numeric minute delay remains unknown. The UI says “Daily period ending.” Extended-hours fields are not substituted for the close. Historical hourly bars retain their actual interval boundaries; bars crossing session boundaries have session `UNKNOWN`.
- Basic access is capped at five requests/minute. Every HTTP request, including reference lookups, passes a PostgreSQL-backed **13-second gate**. A new holding needs two requests and may take about 30 seconds during a batch. Successful completed-day evidence is reused across refreshes/restarts until a new trading date becomes eligible. Multiple holdings/accounts sharing an exact instrument need only one refresh. The UI updates values after each source and continues past instrument-specific missing/invalid data, with a readable error beside the operation. Provider-wide authentication, quota or transport failures stop the batch and impose a one-minute durable cooldown; no automatic retry, pagination, upgrade or fallback occurs. Stopping a batch prevents subsequent holdings from being dispatched; an in-flight refresh may still finish. A stopped batch is not reported as fully finished.
- Only prior completed New York trading dates are requested, including weekend/holiday handling. Calendar coverage remains 2026–2027. No same-day entitlement is assumed. Evidence remains append-only and last-good values survive provider failures.

Additive migration **0009** creates `market_provider_limits`; **0010** extends the market-evidence provider constraint to accept Massive. Generated snapshots and the ERD accompany them. No portfolio schema or financial state changes are required. The HTTP proxy allows a bounded 120 seconds for paced market refreshes.

Provider references: [stock daily summaries](https://massive.com/docs/rest/stocks/aggregates/daily-ticker-summary), [historical bars](https://massive.com/docs/rest/stocks/aggregates/custom-bars), [option daily summaries](https://massive.com/docs/rest/options/aggregates/daily-ticker-summary), [contract reference](https://massive.com/docs/rest/options/contracts/contract-overview), and [Basic pricing/access](https://massive.com/pricing?product=options). Key/account entitlements still require a real request to verify; offline tests do not establish account access.

## Listing names and logos

Holdings display provider listing names instead of workbook descriptions or asset-class placeholders. Repeated positions share a cached listing; option legs use the underlying listing name/logo while retaining their own strike, expiry, right and multiplier. Missing names say **Listing name unavailable**. Missing or broken logos show a neutral company/fund icon, never ticker initials or an invented brand. Search includes listing names. A row tooltip identifies the metadata provider and retrieval time. Refresh progress omits exchange placeholders such as `UNKNOWN`, `US` and `SMART`.

Set `LISTING_PROVIDER=massive` to use the existing backend `MASSIVE_API_KEY` for reference names/branding, independently of `MARKET_PROVIDER`. For example, IBKR may supply prices while Massive supplies display metadata; the UI explicitly labels Massive as the listing source. This is a separately configured source, not provider fallback. `LISTING_PROVIDER=fixture` supplies synthetic names/demo logos for offline testing; `none` (the default for an existing environment) disables external listing enrichment. No extra account or paid inference is needed. [Massive ticker overview](https://massive.com/docs/rest/stocks/tickers/ticker-overview) includes reference names and branding in Stocks Basic; branding coverage varies by listing, especially ETFs.

**Refresh portfolio prices** also fills missing/stale listing details after price requests complete. **Refresh listing details** updates names/logos independently. Both actions are explicit, bounded to 50 requests, serialized, idempotent and stoppable. Navigation, search, image rendering and Agent reads never call the external provider. Existing metadata is reused for seven days; a failed logo retrieval can be retried after five minutes. Every reference/image request shares Massive's durable 13-second gate. A first fill may take several minutes under Basic limits. Missing logos do not discard a valid name; a failed reference lookup preserves prior metadata. Refreshing metadata never changes a portfolio revision, quantity, cash, recorded workbook description or transaction history.

Additive migration **0012** allows `listing` observations in the existing market evidence store. Full reference responses, normalized identities, retrieval/availability timestamps and bounded logo bytes are persisted in PostgreSQL. The Drizzle snapshot is included; ERD generation was run and the constraint-only change leaves the diagram unchanged. Symbol, currency, exchange and stock/ETF class are validated against the listing; an option's underlying may resolve to either supported class. Names are the provider's complete `name` field, not an AI-written description or copied workbook label. Metadata is display-only and never establishes a price or trade signal.

The browser receives cached names and local image URLs through `GET /api/v1/portfolio/listings`; the response exposes its listing source and pending lookup requests. `POST /api/v1/market/refresh` additionally accepts `{kind:"listing",lookup:{symbol,exchange,currency,assetType}}`, routed only to the configured listing provider. `GET /api/v1/market/listings/:observationId/logo` serves cached bytes only. External branding hosts and paths are allowlisted; redirects, arbitrary URLs, active SVG content and oversized responses are rejected. Images receive restrictive CSP/nosniff headers; keys and provider authorization URLs are never sent to the browser. These are display enrichments; financial source evidence remains unchanged.

## Optional IBKR hosted MCP connection

The optional [IBKR hosted MCP adapter](IBKR_MCP.md) provides a separate read-only market-data connection. Its OAuth setup, supported fields, timestamp limits and operating boundary are documented separately. It does not reuse desktop-plugin authorization or replace your selected provider automatically.

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

Initial M3 testing used mocked transports for response normalization, identity mismatches, missing keys, absent options entitlement, errors and throttling. Later account and portfolio verification is recorded below. Automated schedules remain M6, research M4, and risk planning M5.

### Completed verification — 2026-10-31

- 115 offline unit tests, 29 PostgreSQL integration tests and all 19 browser tests passed.
- Formatting, lint, strict typecheck, ERD freshness and Docker Compose validation passed. API, worker and Next.js production images built successfully; all services became healthy.
- The full browser suite ran against fresh isolated fixture databases. Desktop/browser flows and a narrow-screen screenshot were checked, including Agent valuation, quote/chart/options provenance, snapshot saving and existing portfolio confirmations.
- Integration verification exposed and fixed a pre-existing chat completion race: terminal status and the final event now commit atomically. Interrupted market refresh recovery and zero foreign-currency cash balances also have regression coverage.
- The local app was updated using the tested images and additive migration. Its confirmed portfolio revision remained 8 before and after deployment. No real portfolio changes, live market-provider calls or paid inference were performed by this work.

### Massive Basic extension verification — 2026-10-31

- 126 offline unit tests, 31 PostgreSQL integration tests and 20 browser tests passed. The new checks cover source precision, ticker/contract matching, missing data/keys, EOD labels, free-tier pacing, cache/idempotency and durable rate reservations across repository instances.
- Strict typecheck, lint, formatting, ERD freshness, Compose validation and production image builds passed. The disposable stack also started in `massive` mode with an empty key and returned `MARKET_NOT_CONFIGURED` on refresh without a provider request.
- At implementation completion, real Massive account access was **not yet verified** because `MASSIVE_API_KEY` was blank. An empty placeholder was added to the existing ignored `.env`; existing OpenAI settings and fixture market mode were preserved.

### Configured account verification — 2026-10-31

After the user supplied a Massive key locally, the app was switched to `MARKET_PROVIDER=massive` and restarted successfully. Real requests through the application verified the October 30 TSLA stock close and the standard TSLA December 18, 2026 $450 call close. Both returned `SUCCEEDED` and persisted provider evidence with Basic end-of-day labels. This verifies those sample endpoints and account access, not full portfolio coverage, live quotes or Greeks. No OpenAI inference was invoked. Portfolio revision remained 8 and the holdings/cash state hash was unchanged. The key stays in the ignored `.env` and was not displayed or committed.

### Portfolio refresh regression verification — 2026-10-31

- Fixed imported `UNKNOWN` exchanges stopping the portfolio batch before the first price. Provider reference verification preserves the ledger instrument identity and rejects stock/ETF or contract mismatches.
- 129 offline unit tests, 31 PostgreSQL integration tests and all 22 browser tests passed. Regression coverage includes progressive valuation updates, continuing after an unavailable holding, stopping on provider-wide access failures, and selecting ETFs on the Market page.
- Formatting, lint, strict typecheck, ERD freshness, Compose validation and all three production image builds passed. The tested images were deployed to the local app; API, worker, web and PostgreSQL became healthy.
- A real portfolio refresh through the application succeeded for every distinct requested stock, ETF and standard option source, leaving no unpriced holdings. The run respected the Basic HTTP gate and retained end-of-day provenance. The portfolio revision and holdings/cash state hash were unchanged; no financial changes or OpenAI inference occurred.
- A read-only browser check against the updated local app verified every rendered holding mark against its API response, checked end-of-day labels, and found no browser page errors. Disposable test services were stopped without deleting volumes; the main app remains running.

### Listing display verification - 2026-10-31

- 152 offline unit tests and 33 PostgreSQL integration tests passed. Coverage includes source identity/class mismatches, bounded and restricted image retrieval, missing logos, cache reuse, cache expiry with changed image bytes, local image delivery and unchanged financial state.
- All 25 browser checks passed after correcting a test selector that briefly matched a remounted broken image. Targeted account/holding context and listing tests were rerun after the mobile layout refinement. Full listing names have a wide identity row on narrow screens, with quantity/cost/context below it; desktop grouping and selection remain intact.
- Lint, strict typecheck, formatting, ERD freshness and Compose validation passed. All three production images built and became healthy. A real HTTP smoke check verified fixture metadata refresh, cache reuse and sandboxed local image delivery without portfolio changes.
- Listing metadata is explicitly configured as Massive in the local deployment while IBKR remains the selected price provider. Real company images were checked in desktop and mobile browsers with no page errors. Test services were stopped without deleting volumes.
- The available IBKR MCP tool schemas were checked after the user asked about that source. Contract search supplies descriptions, but the checked ETF description is abbreviated and no available tool exposes company logos. Massive remains the explicit source for this full-name/branding feature; no new IBKR account or trading tools were enabled.

- The completed real-provider fill populated a listing name for every current holding and downloaded every available branding image. Missing provider branding uses the neutral fund icon. A final read-only browser check matched every holding name against its stored listing, loaded every supplied image, verified readable mobile names and found no browser page errors. The portfolio revision and holdings/cash checksum were unchanged; IBKR stayed selected for prices. No financial confirmations or paid inference were performed.
