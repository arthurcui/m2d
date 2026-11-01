# M4 — Research and motive intelligence

Research retrieves issuer reports, accepts PDF/plain-text documents, preserves original evidence, and lets Agent discuss that evidence with citations. It never changes holdings, cash or trade history. M5 risk/trade planning and M6 scheduled monitoring are not implemented.

## Use

1. Open Research and choose a company ticker (portfolio underlyings and saved companies appear as suggestions).
2. Retrieve reports, or upload a PDF/UTF-8 `.txt` document. A document import is separate from an Excel portfolio replacement and needs no financial confirmation.
3. Choose a before and after report, compare changed passages, inspect quoted issuer statements, search, or inspect financial history.
4. Choose **Discuss with Agent**. Review/send the prepared question using Enter. Research has its own persistent conversation and existing Quick/Standard/Extensive allowances. Company and historical cutoff accompany each question; the backend enforces that cutoff on research tool reads.

Selections, comparisons, file selections and unfinished imports survive navigation while the app remains open. Imports and conversations survive reloads; a running import is recovered by polling. Browser-only selections reset on a full reload.

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
- Duplicate `(company, provider, upstream key, content hash)` records reuse the original document. Different content for the same upstream key creates a new revision. Upload filename is its upstream key: keep the filename to revise a document; distinct filenames remain separate sources.
- `available_at` is the later of first ingestion and known publication time. Historical queries conservatively use what M²D had received, not what an external party might have known earlier. SEC's current XBRL response is never backdated to old reporting periods.
- Financial values preserve decimal source tokens, taxonomy/tag, native unit, start/end period, accession and filing date. Historical fact queries select the latest source revision **available at the requested time**, retaining distinct reported accessions/restatements. Financial history shows up to 500 rows; Agent fact retrieval is bounded to 40 rows. No ratios, restatement reconciliation, FX conversion or derived returns are inferred.
- Source passages preserve PDF page numbers and stable document-local indexes. Company search combines indexed English full-text retrieval with optional pgvector semantic retrieval, applies company/date/source filters before ranking, and preserves passage citations. Indexing is explicit and cached; the UI and Agent share the same service. See [company search](COMPANY_SEARCH.md) for contracts, budgets and limits.
- Claims are **quoted issuer statements**, selected by deterministic guidance/risk/financial keyword rules (`quoted-passages-v1`), not verified truths or model-extracted numerical facts. They cite exact stored passages. Agent adds interpretation only on request and must separate it from the source claims.
- Comparison shows exact changed passages side by side, with source links. It does not pretend to align semantically equivalent sections or calculate like-for-like growth from mismatched periods. The UI caps each side at 20 passages; Agent comparison reads cap each side at three, explicitly reporting truncation. Full source text remains available.
- Agent citation document IDs are checked against research evidence actually retrieved in the conversation. Original HTML/PDF downloads are attachment-only with sandbox/nosniff headers; source text is rendered as text. Model text is not executed as HTML.

## Import behavior and limits

M4 uses explicit, bounded API background imports, tracked by durable request IDs/statuses. It follows the existing manual market/chat pattern; no research monitor or inference runs on a schedule. All documents in an import commit transactionally after parsing succeeds. A failed import leaves the last good research intact. Repeated request IDs return their saved status and reject changed payloads. Source hashes additionally deduplicate separate requests. API restart marks interrupted imports for an explicit retry; M4 does not silently reissue external requests. See the M4 ADR for this deviation from the long-term worker pipeline.

PDF extraction runs in a separate process with a 128-MiB JavaScript heap cap and 30-second deadline. Inputs are limited to 12 MiB, 200 PDF pages and 3.6 million extracted characters. Scanned/image-only, encrypted and malformed PDFs require a text-based replacement; OCR is not implemented. HTML extraction strips executable content. `pdf-parse` and `html-to-text` are the two parsing dependencies; they avoid ad-hoc PDF/HTML decoding.

## HTTP and tools

All responses use the existing versioned envelope. Writes use the same-origin web proxy.

| Contract                                            | Purpose                                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `GET /api/v1/research`                              | Provider readiness, companies and recent import health                            |
| `POST /api/v1/research/import`                      | Explicit issuer retrieval: version, UUID idempotencyKey, symbol                   |
| `POST /api/v1/research/upload`                      | PDF/text upload: version, UUID, symbol, name, contentBase64, optional publishedAt |
| `GET /api/v1/research/imports/:id`                  | Durable processing/completed/failed/interrupted status                            |
| `GET /api/v1/research/companies/:symbol?at=…`       | Point-in-time document timeline and financial history                             |
| `GET /api/v1/research/documents/:id?at=…`           | Metadata, claims and source passages                                              |
| `GET /api/v1/research/documents/:id/raw`            | Download preserved original                                                       |
| `GET /api/v1/research/search?symbol=…&query=…&at=…` | PostgreSQL full-text search                                                       |
| `POST /api/v1/research/compare`                     | Version, before/after document IDs and optional cutoff                            |

The shared search additions are `research_search_evidence_v2`, `research_read_passage_v1`, `research_query_facts_v2` and `research_find_company_v1`. Compatible original Agent read tools are `research_search_filings_v1`, `research_search_documents_v1`, `research_get_company_facts_v1` and `research_compare_revisions_v1`. They cannot download external data, execute SQL or mutate financial state. All inference continues through the existing provider-neutral `LlmProvider` and run budgets.

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

Live SEC retrieval has not been exercised with a configured contact identity in this delivery. The initial delivery used fixture inference only. Subsequent live OpenAI embedding and Agent evaluation passed after fixing inferred search filters; see [the measured results and remaining limits](COMPANY_SEARCH.md#live-evaluation-and-agent-grounding). Live inference on synthetic reports does not establish live SEC ingestion or broad real-filing accuracy.

## Public-source extension

Company IR, ETF/fund documents, OCC notices, official economic releases and financial-news summaries can now be saved and imported from the Research source library. Source settings persist by company; originals, revisions and citations share the existing research pipeline. See [supported inputs, API contracts, limits and live checks](RESEARCH_SOURCES.md). Retrieval remains user-triggered in M4.

See [Analyst Research](ANALYST_RESEARCH.md) for public bank sources, categorized uploads, cited fields and Agent comparisons.

## Company charts

See [company charts](COMPANY_CHARTS.md) for source-linked price/event and financial-trend visuals, historical cutoffs, period comparability, live verification and coverage limits.
