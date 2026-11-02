# Analyst Research (M4)

Research → select a company → Sources → Analyst Research. Goldman Sachs and Morgan Stanley public pages are available as starting points. Browse and select a relevant public report; these pages are not complete client libraries and may cover a sector rather than the selected company. Save other permitted public URLs with the Analyst Research category. For licensed reports you are permitted to process, choose **Document category → Analyst Research** before uploading PDF/text.

Reports retain their original bytes, hash, revision, declared publication date and conservative observation-based availability. Original publication times absent from a PDF remain unknown. The source filter separates analyst reports from filings, issuer material and news. Paid client portals, brokerage research downloads and paywall bypasses are not implemented; the IBKR market-only connection is unchanged.

The document view shows versioned, deterministic **exact labelled excerpts** for publisher, analyst, report date, rating, target, currency, horizon, forecasts, valuation assumptions, catalysts and risks. Fields that are not explicitly labelled remain unknown. This is a conservative aid, not a complete parser for arbitrary report layouts. No currency is inferred from `$`, and no 12-month horizon is assumed. Multiple or conflicting labelled passages remain visible. Excerpts are reproducible from immutable persisted chunks, not stored as authoritative company facts.

Use **Analyze / compare analyst reports with Agent** for natural-language interpretation of other formats and comparison with stored reports for the selected company. This prepares an editable question; sending it uses the normal configured inference provider and selected work allowance. Agent must cite fields and report dates, distinguish opinions from reported results, and identify missing evidence. A limited set of stored reports is never called market consensus. Use the existing before/after document comparison to inspect exact changes between editions or reports. No target is an executable trading signal and no research import changes holdings/cash.

Contracts: source kind and v2 search source accept `analyst`. Upload v1 accepts optional `category: upload | analyst` (default `upload`, preserving old fingerprints); analyst uploads have provider `analyst` and form `ANALYST`. Document reads add nullable `analyst: {version, fields: [{field, excerpts: [{text, chunkIndex, page}]}]}`. Derived profile version is `analyst-labels-v1`. Migration 0017 expands the two provider/category checks; ERD is regenerated (no new entities).

Offline tests cover exact extraction, missing values, upload deduplication, search filtering, historical exclusion and browser/Agent handoff. Repeatable bounded live check, using public research and a disposable database:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://m2d:test-only@127.0.0.1:55434/m2d_test'
pnpm eval:research-sources --analyst --live
```

The existing USD 0.25 / 20,000-byte / five-attempt evaluation ceilings apply (or lower deployment limits). Reports are ignored `.tmp/research-analyst-live-report.json`; no production portfolio is read. Public availability does not establish rights to process a restricted report; only use permitted content. This adds no new paid provider or autonomous monitoring.

## Verification — November 1, 2026

183 unit, 48 PostgreSQL/API integration and 34 browser tests passed, together with strict typecheck, lint, formatting, ERD consistency and Docker builds. Both public bank landing pages downloaded and yielded discovery links. An isolated live Goldman Sachs article import preserved its hash and produced seven passages; hybrid search and the configured OpenAI Agent answered with local saved-passage citations and absent target details marked unknown. The successful Agent run used 11,827 input and 516 output tokens. An earlier live attempt used external URLs instead of local citations and failed the harness; explicit citation guidance was tightened and the rerun passed. This single check does not establish exhaustive analyst-report extraction or full institutional-library access.

No new inference adapter was introduced. The default importer performs no AI calls; users explicitly send the prepared comparison question to Agent. Public discovery lists are bounded to 30 links, prioritizing article/PDF links above navigation. The application database was backed up before migration; test inputs remained isolated from the actual portfolio.
