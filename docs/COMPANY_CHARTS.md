# Company charts

The Research company view pairs cached hourly closes with reported financial trends. Search results remain text/evidence focused. Charts use the selected price provider from Market/Portfolio; selecting a company only reads PostgreSQL. **Refresh price history** explicitly requests the existing bounded historical feed. There is no automatic refresh, new provider, inference call or portfolio mutation. The chart resolves its listing automatically on explicit refresh. The exchange is informational; only multiple supported exact matches produce a listing-choice prompt. It never defaults an unresolved symbol to NASDAQ.

Price points show exact source close, currency, provider, session, as-of, delay, quality, entitlement, adjustment and storage time. All bars are historical hourly observations, not live quotes or total returns. Coverage is the existing provider window (up to 100 bars), not a new multi-year feed. Clicking/focusing a point exposes its metadata. Publication markers appear only for dated stored reports within that window; event sources open preserved documents and prepare editable Advisor questions. Markers represent publication, not proof of causation. Undated reports and XBRL/index inventories are not plotted as events. At most 20 publication markers are shown.

Financial charts group by exact taxonomy metric, provider and original unit. They never mix real and synthetic sources, currencies or differently named revenue tags. Quarter-length periods are 75–105 days and annual periods are 330–380 days, with exact source dates visible; instant metrics have a separate selector. Cumulative year-to-date values are excluded, not subtracted into inferred quarters. For each exact period, the latest filing known at the cutoff is selected; conflicting values with the same latest filing date are withheld. Revisions remain in immutable source history. The latest 24 comparable observations are displayed from the existing 500-fact API cap. Missing periods are not zero and categorical bar spacing does not imply consecutive quarters.

Source values remain decimal strings; floating point is used only for SVG pixels and compact axis labels. No new ratios, free cash flow, forecasts, analyst consensus or trade signals are calculated. Those need separately validated definitions and coverage. Financial points offer **Open financial source** and **Explain this figure**, which prepares an editable, source-specific Advisor question under the existing research scope and work allowance.

`GET /api/v1/market/bars/:ticker` now accepts optional ISO UTC `at`. It uses the existing repository availability gate and does not fetch a provider. Research historical views pass the same cutoff to price history and facts; price refresh is disabled in that view. A source imported today is not treated as known at its earlier publication time. No schema migration is needed.

## Verification

```powershell
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
# Disposable PostgreSQL/pgvector only:
$env:TEST_DATABASE_URL = 'postgresql://m2d:test-only@127.0.0.1:55434/m2d_test'
pnpm test:integration
# Fixture-only separate Compose project, never actual portfolio:
$env:E2E_BASE_URL = 'http://127.0.0.1:3117'
$env:E2E_ALLOW_PORTFOLIO_WRITES = '1'
pnpm test:e2e
# Optional bounded live public-price check, using the existing backend key:
pnpm --filter @m2d/api... build
node --env-file-if-exists=.env scripts/evaluate-company-charts.mjs --live
```

The live script requires a disposable database, permits up to three Massive HTTP requests (listing resolution, historical identity check and bars), or up to 24 bounded IBKR transport requests including MCP setup, retains the existing 13-second pacing, creates/drops only its own database and checks that the historical cutoff hides later observations. Its ignored report is `.tmp/company-charts-live.json`. On November 1, 2026, Massive returned 80 NVDA hourly bars spanning October 26 09:00 UTC through October 31 00:00 UTC, labelled DELAYED / adjustment NONE; storage, cutoff and unchanged-portfolio checks passed. No model was called, so inference usage/cost was zero. No new paid entitlement was requested.

SEC fundamental retrieval still requires a valid configured contact identity. This delivery verifies financial chart selection against fixtures; the live price check does not establish real SEC ingestion coverage. Existing scanned-PDF and arbitrary financial-table extraction limits remain.

Final verification: 189 unit tests, 49 PostgreSQL/API integration tests and all 35 browser tests passed. Strict typecheck, lint, formatting, ERD consistency, Compose validation and Docker builds passed. Desktop/mobile screenshots were inspected, including readable small-screen axes, source navigation, Advisor handoff, failed-refresh preservation and historical empty states. The full browser suite requires a fresh disposable database: its portfolio replacement test intentionally rejects an already populated fixture portfolio. Production was backed up before deployment; no schema changes were needed.

A subsequent [live SEC verification](M4_RESEARCH.md#live-sec-verification--november-1-2026) succeeded after contact configuration, including real NVDA financial facts. This supplements the fixture chart tests and earlier live price check; no broad arbitrary-filing coverage is claimed.

## Automatic listing resolution

The first refresh resolves exact supported US stock/ETF candidates through the selected price provider, persists the original response and normalized identities, and retrieves history automatically when there is one match. Zero matches produce a no-coverage message; multiple matches produce named choices with exchange/currency/identity. IBKR contract IDs distinguish even two candidates on the same exchange. Identical IBKR IDs are deduplicated and foreign/fuzzy matches excluded. Massive uses primary-exchange reference metadata; Twelve Data uses exact symbol-search results within its supported USD US universe. Fixtures include SPY on ARCA and an explicitly synthetic DUAL ambiguity. No logos or inference are required.

`POST /api/v1/market/refresh` v1 adds `{kind:"resolution",symbol}`. `GET /api/v1/market/resolutions/:ticker?at=...` reads saved evidence only. Bar requests/reads add optional `listingId`, and the backend verifies the chosen identity against a resolution no older than 24 hours before a new provider request. Historical reads use the original availability cutoff. Resolution cache lasts 24 hours; manual refresh never silently switches providers. Twelve Data's explicit refresh waits eight seconds between resolution and history; Massive/IBKR retain their database request gates. Changing companies/providers discards stale responses and prevents unfinished resolution from starting a new request for the wrong company. Chart selection persists while navigating between functions.

Migration 0018 expands the observation-kind constraint only; prior market and portfolio records remain intact. The Drizzle snapshot and regenerated ERD accompany it (no entity changes). The existing explicit-exchange API remains compatible for older callers; the Research chart uses verified identities.

Provider contract reference: [Twelve Data symbol search](https://twelvedata.com/docs/markets/market-state); Massive and IBKR use their already integrated reference/search tools. Available listing sets remain bounded by each adapter and entitlement; this does not add international exchanges or broker account access.

### Listing-resolution verification — November 1, 2026

Offline checks passed: 198 unit tests, 51 PostgreSQL/API integration tests, and the 36-test browser suite. The final chart-specific browser checks cover automatic ARCA resolution, real ambiguity without a premature history request, navigation persistence, historical cutoffs and no-match feedback. Typecheck, lint, formatting, ERD consistency and Docker builds were also checked. Migration 0018 changes no entities, so generated ERD content is unchanged. Identical reference bytes verified again after expiry create new availability evidence; the cache-renewal regression test exercises that boundary.

Bounded live checks used isolated disposable databases and public NVDA inputs, preserving the portfolio and saved provider preferences:

- Massive: one NASDAQ listing, 3 HTTP requests, 80 stored hourly bars from October 26 09:00 UTC to October 31 00:00 UTC; DELAYED and adjustment NONE.
- IBKR hosted MCP: one NASDAQ contract (4815747), 11 transport requests including protocol setup, 100 stored completed hourly bars from October 12 19:00 UTC to October 30 20:00 UTC. Delay/quality and adjustment remain UNKNOWN because the response does not establish them; these are historical bars, not a live-price claim.

The live IBKR response supplied 108 points despite requesting 100 and encoded some volumes in scientific notation. The adapter now accepts at most 500 source points, preserves original evidence, retains the latest 100 completed points, and converts bounded scientific-notation volumes exactly with decimal.js. Oversized responses, negative volumes and malformed numeric values still fail validation. The first attempts exposed these parser failures; the final check passed storage/readback, historical-cutoff and unchanged-portfolio assertions. Both providers used zero model calls/tokens and USD 0 inference cost; provider access remains subject to existing entitlements. Twelve Data resolution is covered by offline adapter tests only, not a live check.

The local deployment was backed up before migration 0018. All four Compose services became healthy; read-only checks confirmed unchanged portfolio revision/state and saved provider/analysis preferences, preserved Research navigation state, and no browser errors or write requests. Start or rebuild with `docker compose up -d --build --wait`; open `http://127.0.0.1:3000/research`.
