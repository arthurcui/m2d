# Company charts

The Research company view pairs cached hourly closes with reported financial trends. Search results remain text/evidence focused. Charts use the selected price provider from Market/Portfolio; selecting a company only reads PostgreSQL. **Refresh price history** explicitly requests the existing bounded historical feed. There is no automatic refresh, new provider, inference call or portfolio mutation. Use the chart exchange selector to identify the listing; it defaults to NASDAQ and is never guessed from an ambiguous symbol.

Price points show exact source close, currency, provider, session, as-of, delay, quality, entitlement, adjustment and storage time. All bars are historical hourly observations, not live quotes or total returns. Coverage is the existing provider window (up to 100 bars), not a new multi-year feed. Clicking/focusing a point exposes its metadata. Publication markers appear only for dated stored reports within that window; event sources open preserved documents and prepare editable Agent questions. Markers represent publication, not proof of causation. Undated reports and XBRL/index inventories are not plotted as events. At most 20 publication markers are shown.

Financial charts group by exact taxonomy metric, provider and original unit. They never mix real and synthetic sources, currencies or differently named revenue tags. Quarter-length periods are 75–105 days and annual periods are 330–380 days, with exact source dates visible; instant metrics have a separate selector. Cumulative year-to-date values are excluded, not subtracted into inferred quarters. For each exact period, the latest filing known at the cutoff is selected; conflicting values with the same latest filing date are withheld. Revisions remain in immutable source history. The latest 24 comparable observations are displayed from the existing 500-fact API cap. Missing periods are not zero and categorical bar spacing does not imply consecutive quarters.

Source values remain decimal strings; floating point is used only for SVG pixels and compact axis labels. No new ratios, free cash flow, forecasts, analyst consensus or trade signals are calculated. Those need separately validated definitions and coverage. Financial points offer **Open financial source** and **Explain this figure**, which prepares an editable, source-specific Agent question under the existing research scope and work allowance.

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

The live script requires a disposable database, permits exactly two provider HTTP requests (listing identity and historical bars), retains the existing 13-second pacing, creates/drops only its own database and checks that the historical cutoff hides later observations. Its ignored report is `.tmp/company-charts-live.json`. On November 1, 2026, Massive returned 80 NVDA hourly bars spanning October 26 09:00 UTC through October 31 00:00 UTC, labelled DELAYED / adjustment NONE; storage, cutoff and unchanged-portfolio checks passed. No model was called, so inference usage/cost was zero. No new paid entitlement was requested.

SEC fundamental retrieval still requires a valid configured contact identity. This delivery verifies financial chart selection against fixtures; the live price check does not establish real SEC ingestion coverage. Existing scanned-PDF and arbitrary financial-table extraction limits remain.

Final verification: 189 unit tests, 49 PostgreSQL/API integration tests and all 35 browser tests passed. Strict typecheck, lint, formatting, ERD consistency, Compose validation and Docker builds passed. Desktop/mobile screenshots were inspected, including readable small-screen axes, source navigation, Agent handoff, failed-refresh preservation and historical empty states. The full browser suite requires a fresh disposable database: its portfolio replacement test intentionally rejects an already populated fixture portfolio. Production was backed up before deployment; no schema changes were needed.
