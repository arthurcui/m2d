# 10 — Verification, Tests, and Definition of Done

## 1. Test layers
- `unit`: decimal money, FX, portfolio projections, options payoff, signs/cost flows, risk, state machines, score formulas.
- `property`: invariant tests (via fast-check or similar) for replay idempotence, no ghost positions, balanced transfers, validation, long/short payoff behavior.
- `integration`: real ephemeral PostgreSQL, migration up/down where safe, full Excel staging/commit/rollback, pg-boss retries, research versioned ingest, Fastify contracts.
- `provider-contract`: deterministic recorded fixtures for market data and LLM responses; no network/API keys in CI. Exercise the `LlmProvider` contract and OpenAI request/response translation with mocked transport, as specified in `docs/14_LLM_PROVIDERS.md`.
- `e2e`: Playwright local compose: import -> review -> confirm -> natural language trade -> verify dashboard -> restore snapshot.
- `evaluation`: frozen benchmark datasets and golden scenarios for AI action extraction, grounded retrieval/citations, signal lifecycle and point-in-time research.

## 2. Mandatory fixture scenarios
1. Seven accounts with overlapping tickers, long positions, short calls, and USD/CAD cash; no accidental account merge.
2. Short covered call: short qty `-1`, multiplier 100, premium added to cash, option liability negative; no invented initial profit.
3. Call strike/expiry distinguish nearby contracts and adjusted multipliers.
4. Sell-to-close vs sell-to-open correctly classified.
5. Partial close of multiple option contracts with average entry credit and per-fill fees.
6. Covered call against insufficient shares is uncovered and prominently flagged.
7. Cash transfer between accounts: double side ledger, currency explicitly checked, no fake investment P&L.
8. Excel baseline replaces missing positions with zero, missing account deactivates, all older history remains intact.
9. Duplicate Excel file SHA/idempotency not reprocessed.
10. Row error in Excel results in zero partial changes.
11. Stale natural language preview fails to confirm after concurrent Excel replacement.
12. Backdated change before baseline rejected for projection, handled via correction flow.
13. Expiration/assignment: underlying/cash/option legs adjusted atomically; exercise behavior never guessed when ambiguous.
14. Stale regular close reused outside hours must show CLOSED/last regular, cannot be labeled PRE quote.
15. Stock quote and option quote from different timestamps -> data mismatch warning and `WATCH_ONLY` signal.
16. Missing IV history means no confident IV-percentile strategy claim.
17. Research doc V2 supersedes V1 for latest view, but simulated 2026-08-01 sees only facts available at that time.
18. Signal generated before entry remains immutable despite later market move; evaluation uses original trigger.
19. Simulated fill not displayed as actual transaction.
20. Deposit/withdrawal makes raw NAV delta distinct from valid investment return.
21. API failure or LLM timeout returns typed error, unchanged DB and no fictitious recommendation.
22. Restart all containers: no duplicated jobs, portfolios, alerts, signals or imports.
23. User asks for 3 trades with no valid market data: system explicitly returns no actionable candidates.
24. Market dashboard shows user local and NY exchange clock/time zone correctly across DST.

## 3. Acceptance thresholds (initial engineering targets)
- 100% required accounting fixture results match independently worked examples to decimal precision.
- 0 unconfirmed portfolio mutations in test suites.
- 0 actions classified `ACTIONABLE` without mandatory entry/exit/risk/source/freshness fields.
- 100% retained baseline histories and replay determinism.
- Local compose build and first-run migration/startup reliable with mocked external providers.
- E2E smoke flow complete without LLM/network keys (use fixture adapter).
- LLM SDK imports/types remain inside provider adapters; the same application workflows run with fixture or configured OpenAI through `LlmProvider`.

## 4. LLM provider acceptance checks (M2 onward)
1. **Explicit configuration:** `LLM_PROVIDER=fixture` runs offline with no keys; `LLM_PROVIDER=openai` requires `LLM_MODEL` and server-side `OPENAI_API_KEY`. Missing selected-provider configuration returns a typed configuration error before any network call. Unused future-provider keys are not required. No silent provider or fixture fallback.
2. **Direct API access and secret boundary:** mocked OpenAI requests use the configured server key without ChatGPT sign-in, OAuth or session credentials. Frontend bundles/configuration, API responses and captured logs contain no secret values. `.env.example` contains placeholders only.
3. **Multi-step continuation:** a fixture covers response -> one or more tool calls -> tool results -> final output, including multiple rounds, correct call IDs/order and unchanged opaque continuation. Bind continuation to its provider/model/adapter version; mismatches are rejected or start a documented fresh run from canonical history, never cross-replayed.
4. **Capability checks:** unsupported required tool calling, structured output or streaming fails explicitly before inference. The adapter never silently removes tools, output schemas or required constraints. Schema-valid output still passes deterministic financial validation.
5. **Run limits:** model-call/tool-call attempt limits, elapsed-time and token/output limits, plus configured cost caps, stop further dispatch at documented bounds. Bounded retries count toward the same attempt limits; unknown usage is reported as unknown, not zero. Cost tests reserve estimates across concurrent in-flight calls and persist daily accounting across restart. Budget exhaustion, cancellation and timeout cannot commit a portfolio change or publish a fabricated completed decision.
6. **Result and stream handling:** incomplete, refused and malformed responses stay distinct from completed output. Partial streaming tool arguments are never executed; complete calls and final objects are validated before use. Errors retain sanitized provider/request metadata.
7. **Ownership and idempotency:** provider adapters return tool requests; M²D executes approved application tools and retains confirmation/transaction rules. A retried request or repeated tool result cannot duplicate a committed event. No model SDK or adapter can write portfolio SQL directly.
8. **Dependency boundary:** an import-boundary check prevents native SDK imports/types outside `packages/llm` adapters. A deterministic fake/fixture adapter runs agent and portfolio workflows without changing their code. Gemini and Anthropic Claude remain reserved providers; do not add SDKs or live integrations merely to test reserved names.

CI uses fixtures and mocked transports throughout. Near readiness, provider-backed changes require a bounded live check using the configured key and must report whether it actually ran; it never replaces offline contract coverage or expands the current milestone.

## 5. Analysis mode acceptance checks (M2 onward)
- Resolve explicit request mode, saved default, then environment default; initial default is Standard. Invalid values fail validation. Saving a default persists across restart without changing active runs or existing scheduled jobs.
- All modes pass identical stale-quote, financial-validation, preview/confirmation and evidence checks. Quick cannot turn interrupted/insufficient research into a completed no-signal assessment.
- Enforce each profile beneath deployment ceilings and remaining applicable cost/daily allowance. Retries consume the same budget; client fields cannot raise it. Capture the mode, policy version, effective limits and any caps in run metadata.
- A change to Quick/Standard/Extensive does not silently change provider/model or native continuation. A deeper follow-up is a separately recorded user-selected run; no hidden escalation occurs.
- Exercise the selector, persisted default, progress/cancel and compact-summary/expandable-detail flow with fixtures. See `docs/15_ANALYSIS_MODES.md`; no assertion of exact live-provider speed, cost or improved accuracy.

## 6. Final completion report for each milestone
Codex must provide: scope delivered, exact commands, migration changes, tests executed/results, E2E verification, known limitations, and next milestone blockers. No claiming success with skipped or broken tests.

### Company search (M4 extension)

Use PostgreSQL 17 with pgvector for integration tests. Cover shared UI/Agent contracts; exact keyword hits and decimal strings; rank fusion and repeated-source diversity; company/source/form/publication filters; latest revisions as of a cutoff; passage context; structured fact unit/period filters; idempotent indexing and cache reuse; unknown usage and restart recovery; daily-byte/cost and Agent-attempt ceilings; invalid provider output; mobile citation navigation and retained drafts. Synthetic vectors test retrieval mechanics only. An authorized live evaluation on representative questions is required to establish OpenAI semantic relevance.


Run `pnpm eval:company-search` for the repeatable offline harness, or add `--live` for real embeddings and cited Agent answers using the existing backend key. Set `TEST_DATABASE_URL` to a separate pgvector server first. The harness uses isolated synthetic reports, fixed expected sources, predefined top-1/top-3 thresholds, exact facts, historical isolation, cache reuse, a no-match question and an unsupported-answer check. Reports include model, measured relevance, usage/cost, failures and tool traces; fixture success is not a live relevance result. See [the setup, recorded live results and limits](COMPANY_SEARCH.md#live-evaluation-and-agent-grounding). CI never invokes the live check.
