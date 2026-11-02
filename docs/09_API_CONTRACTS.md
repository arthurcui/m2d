# 09 — HTTP and Event Contracts (Version 1)

All routes prefixed `/api/v1`. Local-first; no user/tenant/auth endpoints. API returns typed objects with `data`, `meta: {asOf, source, portfolioRevision, dataQuality}` where relevant, or typed `error:{code,message,details}`. JSON money as decimal strings.

## 1. Portfolio
| Method/path | Purpose |
|---|---|
| `GET /accounts` | list manually defined accounts |
| `POST /accounts` | create account label (via preview/confirm where holdings affected) |
| `GET /portfolio/overview` | consolidated current state and valuation quality |
| `GET /portfolio/positions?accountKey=` | account/symbol/option positions |
| `GET /portfolio/cash` | cash by account and currency |
| `GET /portfolio/history` | baselines, events, snapshots |
| `POST /portfolio/changes/parse` | NL -> structured candidate and missing fields |
| `POST /portfolio/changes/preview` | candidate -> exact before/after preview with expected revision |
| `POST /portfolio/changes/{previewId}/confirm` | commit confirmed increment with idempotency and revision guard |
| `POST /portfolio/imports` | multipart Excel -> staged parsed import; no mutation |
| `GET /portfolio/imports/{id}/preview` | entire diff, errors, warnings, removals, new baseline |
| `POST /portfolio/imports/{id}/confirm` | single-transaction full replacement |
| `POST /portfolio/baselines/{id}/restore-preview` | restore-as-new-baseline preview |
| `GET /portfolio/accounts/{id}/history` | account events and point-in-time versions |

## 2. Market/research
- `GET /market/quotes?symbols=...` / `GET /market/bars/{ticker}` / `GET /market/options/{ticker}?expiry=...` / `GET /market/fx?pair=...`
- `GET /market/status` returns provider, asOf, session, stale/delayed and last-success per feed.
- `GET /companies/{ticker}/fundamentals` / `GET /companies/{ticker}/filings` / `GET /companies/{ticker}/changes`.
- `POST /research/upload` / `GET /research/documents` / `GET /research/documents/{id}` / `POST /research/search`.

## 3. Agent and signals
- `POST /agent/chat` streams SSE events: `run_started`, `text_delta`, `tool_started`, `tool_completed`, `preview_ready`, `signal_ready`, `run_finished`, `run_failed`.
- Chat, manual scan and research-analysis requests accept optional `analysisMode: "quick" | "standard" | "extensive"`. Resolve and freeze mode before dispatch. Invalid values return `VALIDATION_ERROR`; unknown values never silently become Standard. See `15_ANALYSIS_MODES.md` for default precedence and effective caps.
- `GET /settings/analysis` returns the saved default, supported modes and public profile summaries; `PATCH /settings/analysis` updates only the default preference with a settings revision guard. This singleton setting introduces no user/tenant model or credential editing.
- `run_started` and run retrieval include `analysisMode`, `modePolicyVersion`, `effectiveLimits` and any cap warnings; final metadata adds `analysisCompleteness` and `limitReasons`. The client cannot raise deployment ceilings or alter an active run's mode.
- `GET /agent/runs/{id}` and `GET /agent/sessions/{id}` for historic analysis and sources.
- `GET /system/status` includes AI provider/model, configuration/availability status and sanitized usage summaries. It omits keys, authorization headers and provider continuation. Status inspection does not trigger a paid inference request.
- AI SSE events use M²D-owned payloads; no native SDK objects cross the API boundary. Unvalidated streamed text is provisional; `preview_ready` and `signal_ready` appear only after deterministic validation. A refused/incomplete/cancelled run returns an explicit status, never a fabricated completed decision.
- `GET /signals?status=&ticker=` / `GET /signals/{id}` / `GET /signals/{id}/history` / `POST /signals/scan` triggers asynchronous scan and returns job ID.
- `GET /risk/summary` / `POST /risk/scenarios` / `POST /strategies/evaluate`.
- `GET /journal/trades` / `POST /journal/trades/link` / `GET /performance/overview` / `GET /performance/signals`.
- `GET /watchlists` / `POST /watchlists/{id}/items/preview` / `POST /watchlists/changes/{previewId}/confirm`.
- `GET /jobs` / `GET /jobs/{id}` / `POST /jobs/{name}/run` / `GET /alerts` / `POST /alerts/{id}/ack`.

## 4. Example confirm response
```json
{
  "data": {
    "committed": true,
    "revision": 24,
    "changeId": "uuid",
    "summary": "Sold to open 1 TSLL call in Questrade RRSP",
    "cashChanges": [{"currency":"USD","before":"1000.00","after":"1084.35"}]
  },
  "meta": {"portfolioRevision":24, "dataQuality":"USER_CONFIRMED"}
}
```
All amounts in example are illustrative; no live trade data.

## 5. Contract error codes
`VALIDATION_ERROR`, `AMBIGUOUS_INSTRUCTION`, `INSUFFICIENT_POSITION`, `UNKNOWN_OPTION_CONTRACT`, `MISSING_MARKET_DATA`, `STALE_MARKET_DATA`, `PORTFOLIO_REVISION_CONFLICT`, `EXCEL_IMPORT_INVALID`, `DUPLICATE_IMPORT`, `PREVIEW_EXPIRED`, `PROVIDER_RATE_LIMITED`, `DATA_COVERAGE_INSUFFICIENT`, `JOB_ALREADY_RUNNING`.

AI errors add `LLM_CONFIG_MISSING`, `LLM_PROVIDER_NOT_IMPLEMENTED`, `LLM_AUTH_FAILED`, `LLM_QUOTA_EXHAUSTED`, `LLM_RATE_LIMITED`, `LLM_TIMEOUT`, `LLM_UNAVAILABLE`, `LLM_CAPABILITY_UNSUPPORTED`, `LLM_INVALID_OUTPUT`, `LLM_BUDGET_EXCEEDED`, `LLM_CANCELLED`. Refusal and incomplete generation are explicit run outcomes rather than successful empty answers. Preserve sanitized provider request IDs for diagnosis.

## 6. Worker events
Internally persist: `PortfolioRevisionConfirmed`, `MarketQuoteUpdated`, `OptionChainUpdated`, `DocumentVersionObserved`, `MaterialFactChanged`, `WatchRuleTriggered`, `SignalStatusChanged`, `ScanCompleted`, `AlertRaised`. Include event ID, observed_at, causation ID and idempotency key. Events may be retried; subscribers must be idempotent.

## M1 implementation mapping

The implemented M1 routes, concrete payloads, error handling and workbook template endpoint are documented in [M1_PORTFOLIO.md](M1_PORTFOLIO.md#http-v1). Account creation/update uses `ACCOUNT_UPSERT` through the common preview/confirm routes. Natural-language parsing remains deferred to M2. The remaining routes in this design are future milestone targets.

## Current M1 import identity extension

Remembered interpretations now report `ai.provider="remembered"`, `ai.model="format-v2"` and the confirmed profile timestamp. Rule candidates are saved only by the existing confirmation transaction. Preview warnings disclose rule learning/reuse and current-year expiry assumptions. No new mutation endpoint is introduced.

The parse route also accepts optional `dialogue: {message, question, explain?, history?}` for workbook follow-ups. `clarification` contains previous supplied facts, separately from conversation. Responses may include `acceptedClarification` and `ai.intent="explain"` / `ai.reply`; explanations retain the pending question and cannot produce a preview. See the conversational clarification section of M1_PORTFOLIO.md for bounds and audit behavior.

`POST /api/v1/portfolio/imports/:id/parse` additionally accepts optional `accountDecisions` containing `{sheet,kind:"new"}` or `{sheet,kind:"rename",accountKey}`. Unresolved unfamiliar account tabs return `ai.accountQuestions` with available accounts and no model dispatch/preview. Decisions are audited and committed only through the existing preview confirmation. Positions additionally support optional ISO date-only `transactionDate`. See [M1_PORTFOLIO.md](M1_PORTFOLIO.md) and [the implemented ERD](ERD.md).

## Implemented M2 chat contracts

Persistent sessions, run execution/SSE/cancellation, and revision-guarded analysis settings are described in [M2_CHAT.md](M2_CHAT.md#versioned-api). Chat previews use the existing financial confirmation endpoints; no commit tool is exposed to a model.

M3 implementation details and actual version 1 market routes are in [M3_MARKET.md](M3_MARKET.md). Refreshes are explicit POST requests; GET routes read persisted evidence only. M3 uses singular `symbol` plus explicit exchange/currency for exact quote identity. Research routes above remain future work.

## Implemented M4 research contracts

See [M4 HTTP/tool table](M4_RESEARCH.md#http-and-tools) for research import, upload, timeline, document, comparison and full-text search endpoints. Uploads are bounded base64 JSON; original bytes download as attachments only. Research errors use stable codes and do not modify prior evidence or the portfolio.

### Company evidence search

`POST /api/v1/research/search` accepts body `version: 2` with the shared `EvidenceSearch` schema. GET `/research/search` remains v1 compatible. Typed Agent tools `research_search_evidence_v2`, `research_read_passage_v1`, `research_query_facts_v2` and `research_find_company_v1` use the same source/cutoff gates. Index updates are explicit version-1 POST requests with UUID idempotency keys and durable progress. Full request fields, response provenance and index-status routes: [company search contracts](COMPANY_SEARCH.md#contracts-and-database).


## M5 risk contracts

See [M5 risk API and Advisor tools](M5_RISK.md#contracts-and-storage) for versioned hypothetical calculations, revision-guarded previews and idempotent immutable plan storage. These endpoints never commit portfolio changes.
