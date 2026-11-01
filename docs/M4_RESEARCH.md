# M4 — Research and motive intelligence

Research retrieves issuer reports, accepts PDF/plain-text documents, preserves original evidence, and lets Advisor discuss that evidence with citations. It never changes holdings, cash or trade history. M5 risk/trade planning and M6 scheduled monitoring are not implemented.

## Use

Choose a company explicitly, then use three tabs. Typing only filters saved suggestions; select a suggestion or press Enter to add/use a ticker. The selected company remains visible and supplies Advisor context. Suggestions combine portfolio underlyings, companies with stored research, and explicitly added tickers. Remove from suggestions persists a dismissal in PostgreSQL, including for portfolio tickers; documents and holdings remain untouched. Explicitly adding the ticker again restores it. Ticker syntax is validated locally; adding a suggestion does not verify an issuer or fetch data.

- **Overview**: stored price/event and financial charts, document count, last completed import, search coverage and explicit SEC report refresh with local progress, new/reused counts and last successful check. New evidence is fetched only through an explicit action.
- **Documents**: filter by title/source/type, inspect preserved documents and their citations, and use **Compare reports** to select an earlier and newer report. Recent imports retain their outcomes.
- **Search**: query imported evidence, expand search options or search coverage, explicitly build/update semantic embeddings, and send a prepared question to Advisor.

**Add research** opens a focused view from any tab and hides the tab strip and tab contents. **Back to Research** restores the previous tab, filter and scroll position. Choose **Upload file**, **Paste text**, **From URL** or **Suggested sources**. Paste accepts a title, optional public source URL and optional declared publication time (UTC); absent publication time remains unknown. Pasted text uses the existing versioned UTF-8 upload pipeline, not an LLM. A supplied URL on pasted text is attribution metadata and is not fetched. From URL can import a page/document, find document links on the page, or save it for later. Saved/company-specific sources are separated from general market sources. SEC report refresh remains on Overview, with the same progress, result and request identity as Suggested sources. **Evidence as of** is an advanced cutoff on evidence availability, not the report period; **Latest available** is the default. Switch back to Latest available before importing new evidence.

Each import/browse action displays local progress, completion, errors and links to resulting documents. Controls remain blocked through the durable import job, not merely until its initial HTTP response. Exact-content repeats report **Already saved**; changed source bytes create a revision. Imports report new/reused document counts and searchable passages. An uncertain HTTP response can be retried using the same request ID. Terminal failures allow an explicit new attempt. Navigation and closing the panel do not clear its unsent text, file, URL or operation state while the app stays open. Imported evidence, outcomes and conversations survive reload; pending imports are recovered through status polling. Unsent drafts remain browser-memory state and do not survive a full reload.

Opening a source or Advisor citation selects Documents automatically. Tab switches preserve chart selections, search results, filters and comparison state. Advisor remains in the shared Research context. Discuss actions prepare editable questions; only sending them invokes inference. Imports do not start paid indexing or automatic monitoring and never alter the portfolio.

## Advisor workspace verification (2026-11-01)

Migration 0020 and the ERD are synchronized. Formatting, lint, strict typecheck, Compose validation, all Docker builds, 200 offline unit tests and 55 PostgreSQL integration tests passed. All 43 browser cases passed across the full run and the targeted rerun; these cover explicit company selection, persistent dismissal/restoration, focused Add research, retained drafts/filters, SEC import outcomes, Markdown, responsive layout and changing next-send settings during an active reply. The local stack was redeployed after backup. Read-only browser checks reported no errors or writes; portfolio revision 8 with 36 holdings, research records, preferences and conversation history matched the pre-deployment hashes.

The bounded live OpenAI check used `gpt-5.4-mini-2026-03-17` with synthetic inputs in a disposable database. Quick/English followed by Extensive/简体中文 retained the earlier context label and compatible provider continuation. Both runs completed without a portfolio preview or mutation. The successful pair used 16,937 input and 133 output tokens, estimated USD 0.01330125 at the repository evaluation rates (USD 0.75 / 4.50 per million input/output tokens). Including the earlier language-verification attempt, measured usage was 33,810 input / 233 output tokens, estimated USD 0.026406. A preliminary USD 0.10 reservation check stopped before inference; subsequent checks used the existing USD 0.25 evaluation cap, lowered by any configured deployment limit. These are rate-based estimates, not invoice totals.

To repeat the bounded live check, set `TEST_DATABASE_URL` to disposable PostgreSQL/pgvector, build with `pnpm --filter @m2d/api... build`, then run `node --env-file=.env scripts/evaluate-advisor.mjs --live`. It reuses the configured backend key, creates and drops its own database, sends no user portfolio data, and saves a redacted result under ignored `.tmp/`. CI remains offline. Language selection applies to new Advisor chat replies; fixed UI/status messages and the existing workbook-import dialogue are not localized, and offline fixture replies remain canned examples. Unsent Add research inputs survive navigation, not a full browser reload.

## Sources and setup

The default `RESEARCH_PROVIDER=fixture` is fully offline and prominently synthetic. It produces two example reports, changed guidance/risk passages and decimal financial facts for the requested symbol. It is never actual company research. There is no automatic fallback from SEC to fixtures.

For public SEC retrieval, set these in the existing backend `.env`:

```dotenv
RESEARCH_PROVIDER=sec
SEC_USER_AGENT=M2D your-real-contact@example.com
```

Replace the example address with your contact email, then run `docker compose up -d --build`. SEC requires no API key. The backend identifies itself, serializes requests at less than two per second, applies 20-second request timeouts and a 12-MiB response limit, rejects redirects, and accepts only application-constructed SEC HTTPS URLs. See the [SEC API specification](https://www.sec.gov/search-filings/edgar-application-programming-interfaces) and [SEC fair-access guidance](https://www.sec.gov/about/developer-resources).

The importer resolves the ticker against SEC's issuer map and retrieves the two latest supported reports (`10-K`, `10-Q`, `20-F`, `40-F`, including amendments), submissions metadata and supported aggregate XBRL company facts. No issuer is guessed when a ticker is absent. It does not fetch the complete filing archive or paid research. ETF research uses uploaded fund documents; M4 does not infer ETF exposure from the fund manager's corporate financial statements. Options use underlying-company research.

## Evidence and historical correctness

- Original bytes, SHA-256, source URL, provider, publication time (when supplied), observation time, availability time and revision are immutable PostgreSQL records. Base64 originals are stored alongside the database evidence for atomic import and one consistent backup; they are not placed in `data/research` in M4.
- Duplicate `(company, provider, upstream key, content hash)` records reuse the original document. Different content for the same upstream key creates a new revision. Upload filename remains its revision key, but byte-identical uploads in the same company/category and with the same attributed URL reuse the existing evidence even if renamed. Distinct public-source URLs retain their provenance. Different bytes under the same filename/source create a revision.
- `available_at` is the later of first ingestion and known publication time. Historical queries conservatively use what M²D had received, not what an external party might have known earlier. SEC's current XBRL response is never backdated to old reporting periods.
- Financial values preserve decimal source tokens, taxonomy/tag, native unit, start/end period, accession and filing date. Historical fact queries select the latest source revision **available at the requested time**, retaining distinct reported accessions/restatements. Financial history shows up to 500 rows; Advisor fact retrieval is bounded to 40 rows. No ratios, restatement reconciliation, FX conversion or derived returns are inferred.
- Source passages preserve PDF page numbers and stable document-local indexes. Company search combines indexed English full-text retrieval with optional pgvector semantic retrieval, applies company/date/source filters before ranking, and preserves passage citations. Indexing is explicit and cached; the UI and Advisor share the same service. See [company search](COMPANY_SEARCH.md) for contracts, budgets and limits.
- Claims are **quoted issuer statements**, selected by deterministic guidance/risk/financial keyword rules (`quoted-passages-v1`), not verified truths or model-extracted numerical facts. They cite exact stored passages. Advisor adds interpretation only on request and must separate it from the source claims.
- Comparison shows exact changed passages side by side, with source links. It does not pretend to align semantically equivalent sections or calculate like-for-like growth from mismatched periods. The UI caps each side at 20 passages; Advisor comparison reads cap each side at three, explicitly reporting truncation. Full source text remains available.
- Advisor citation document IDs are checked against research evidence actually retrieved in the conversation. Original HTML/PDF downloads are attachment-only with sandbox/nosniff headers; source text is rendered as text. Model text is not executed as HTML.

## Import behavior and limits

M4 uses explicit, bounded API background imports, tracked by durable request IDs/statuses. It follows the existing manual market/chat pattern; no research monitor or inference runs on a schedule. All documents in an import commit transactionally after parsing succeeds. A failed import leaves the last good research intact. Repeated request IDs return their saved status and reject changed payloads. Source hashes additionally deduplicate separate requests. API restart marks interrupted imports for an explicit retry; M4 does not silently reissue external requests. See the M4 ADR for this deviation from the long-term worker pipeline.

PDF extraction runs in a separate process with a 128-MiB JavaScript heap cap and 30-second deadline. Inputs are limited to 12 MiB, 200 PDF pages and 3.6 million extracted characters. Scanned/image-only, encrypted and malformed PDFs require a text-based replacement; OCR is not implemented. HTML extraction strips executable content. `pdf-parse` and `html-to-text` are the two parsing dependencies; they avoid ad-hoc PDF/HTML decoding.

## HTTP and tools

All responses use the existing versioned envelope. Writes use the same-origin web proxy.

| Contract                                            | Purpose                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/research`                              | Provider readiness, companies and recent import health                                                 |
| `POST /api/v1/research/import`                      | Explicit issuer retrieval: version, UUID idempotencyKey, symbol                                        |
| `POST /api/v1/research/upload`                      | PDF/text upload: version, UUID, symbol, name, contentBase64, optional publishedAt, title and sourceUrl |
| `GET /api/v1/research/imports/:id`                  | Durable processing/completed/failed/interrupted status                                                 |
| `GET /api/v1/research/companies/:symbol?at=…`       | Point-in-time document timeline and financial history                                                  |
| `GET /api/v1/research/documents/:id?at=…`           | Metadata, claims and source passages                                                                   |
| `GET /api/v1/research/documents/:id/raw`            | Download preserved original                                                                            |
| `GET /api/v1/research/search?symbol=…&query=…&at=…` | PostgreSQL full-text search                                                                            |
| `POST /api/v1/research/compare`                     | Version, before/after document IDs and optional cutoff                                                 |

The shared search additions are `research_search_evidence_v2`, `research_read_passage_v1`, `research_query_facts_v2` and `research_find_company_v1`. Compatible original Advisor read tools are `research_search_filings_v1`, `research_search_documents_v1`, `research_get_company_facts_v1` and `research_compare_revisions_v1`. They cannot download external data, execute SQL or mutate financial state. All inference continues through the existing provider-neutral `LlmProvider` and run budgets.

## Verification

```powershell
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm docs:erd:check
docker compose config --quiet
docker compose up -d --build --wait --wait-timeout 180
```

Integration tests require `TEST_DATABASE_URL` pointing to disposable PostgreSQL 17 with pgvector installed. Full E2E requires a fresh fixture-only stack, `E2E_BASE_URL` for that stack and `E2E_ALLOW_PORTFOLIO_WRITES=1`; never enable write tests against a real portfolio. Research coverage includes precision, HTML/PDF handling, SEC adapter contracts, raw-file preservation, atomic failures, deduplication, historical revisions, comparison/search, citations, navigation and mobile layout.

### Original M4 verification

The offline suite passed 163 unit tests, 38 database/API integration tests and 30 Playwright browser tests. Formatting, lint, strict typecheck, generated ERD checks, Compose validation and Docker builds/startup passed. A separate Docker PDF upload verified extracted page anchors, exact original SHA-256, desktop/mobile rendering and no browser errors. Historical-context tests also prevent later conversation evidence from being replayed into an earlier research boundary.

The original M4 delivery had no configured SEC contact identity and used fixture inference only. A subsequent live SEC check passed; see below. Subsequent live OpenAI embedding and Advisor evaluation passed after fixing inferred search filters; see [the measured results and remaining limits](COMPANY_SEARCH.md#live-evaluation-and-agent-grounding). Live inference on synthetic reports does not establish live SEC ingestion or broad real-filing accuracy.

## Public-source extension

Company IR, ETF/fund documents, OCC notices, official economic releases and financial-news summaries can now be saved and imported from the Research source library. Source settings persist by company; originals, revisions and citations share the existing research pipeline. See [supported inputs, API contracts, limits and live checks](RESEARCH_SOURCES.md). Retrieval remains user-triggered in M4.

See [Analyst Research](ANALYST_RESEARCH.md) for public bank sources, categorized uploads, cited fields and Advisor comparisons.

## Company charts

See [company charts](COMPANY_CHARTS.md) for source-linked price/event and financial-trend visuals, historical cutoffs, period comparability, live verification and coverage limits.

### Live SEC verification — November 1, 2026

After configuring a real contact identity in the ignored backend environment, a bounded NVIDIA import in a disposable database completed five HTTP requests, all returning 200: ticker map, submissions metadata, two 10-Q filings, and XBRL company facts. Four documents were preserved and their original-byte SHA-256 hashes verified; the financial-history read returned its capped 500 rows. Portfolio revision stayed unchanged. No LLM was called, so inference usage/cost was zero. Production SEC readiness was enabled through environment configuration; the verification documents were not imported into the user's workspace. This verifies the NVDA path, not all issuers or filing formats.

## Import outcome migration

Migration 0019 adds nullable `added_count`, `reused_count` and `passage_count` to `research_imports`. They are committed atomically with the evidence; a database constraint requires nonnegative completed-job counts consistent with the document ID list. Historical imports retain null counts rather than invented outcomes. GET import-status/recent-import responses expose these additive fields. Source hashes and original availability dates are never rewritten by deduplication. The ERD is regenerated with the three fields.

Live public-source verification used a disposable database and two Federal Reserve calendar requests. The second response contained changed bytes and correctly created a revision; replaying that exact captured response reused its document. Eleven passages, original SHA-256 and unchanged portfolio state were verified. There were no model calls or inference costs. This check covers public HTTP imports and does not establish access to blocked or paywalled sites.

Verification for the three-tab workspace: 198 unit tests, 52 PostgreSQL/API integration tests and the full 41-test browser suite passed. Four targeted browser checks were repeated after the final citation-navigation and narrow-screen refinements. Tests cover retained drafts, operation-local progress, repeated-content outcomes, ambiguous-response retries using the same key, source metadata, revision history, constraints and unchanged portfolio state. Typecheck, lint, formatting, ERD consistency, Compose validation and all Docker builds passed. A PostgreSQL backup was taken before deployment.

After deployment, all four services were healthy. Read-only browser/API checks confirmed unchanged portfolio, saved research documents and provider/analysis preferences, preserved Research-tab navigation, and a functioning Add research panel, with no browser errors or write requests. Start the stack with `docker compose up -d --build --wait` and open `http://127.0.0.1:3000/research`.
