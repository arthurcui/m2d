# M2 — Persistent portfolio Advisor

M2 adds conversation-based self-reported portfolio updates. It does not add market feeds, research retrieval, order execution or autonomous monitoring. Existing workbook interpretation and confirmation remain available.

These are the M2 delivery notes. [M3](M3_MARKET.md) subsequently adds cached market valuation and `market_valuation_read_v1`; research, execution and autonomous monitoring remain unavailable. M3 verification also made terminal run status and its final event persist atomically, preventing a stream from ending before its result/error details are saved.

## Use

Start with `docker compose up --build --detach --wait --wait-timeout 180`, then open http://127.0.0.1:3000. The shared Advisor panel has a separate PostgreSQL-backed conversation for every navigation function. Enter sends; Shift+Enter inserts a line. Drafts are saved to PostgreSQL after a short debounce, with an immediate browser-local copy. Navigating or closing the panel does not cancel a run. Reload reconnects to saved progress. **Cancel run** explicitly stops inference. **New conversation** archives the previous session and retains its run audit records.

Use Quick, Standard or Extensive to select a work allowance. Standard is initially selected; changing the selection automatically persists the preference. An explicit request overrides the saved default, then the deployment default. A follow-up is a new run with a parent ID and the explicitly selected mode. Later research and strategy tools remain unavailable regardless of mode.

For a portfolio already containing 100 AAPL shares in a Margin account, an offline example is:

> Sell to open 1 covered call AAPL in Margin, expiry 2026-12-18, strike 200, premium 2, no fees, standard 100-share contract.

The fixture asks for missing details and proposes a negative one-contract position with a USD 200 cash increase. It does not apply the change. Review the exact holdings/cash diff, warnings, effective time and expected revision, then select **Confirm changes**. Repeat confirmation is idempotent. Concurrent ledger changes invalidate stale previews. An interrupted, refused, cancelled or incomplete run cannot leave a confirmable chat preview.

The deterministic fixture supports explicit stock buy/sell, cash deposit/withdrawal and covered-call examples using existing securities/accounts. OpenAI supports the typed operation vocabulary through the same validators. Neither adapter can commit, execute trades or invoke SQL. Unknown prices, fees, accounts or option terms require clarification. Monetary arithmetic remains in the portfolio package. Coverage checks use self-reported holdings, not broker balances.

## Persistence and execution

- `agent_sessions`: context, canonical text/tool history, private continuation and draft/revision. Archived sessions remain in the database.
- `agent_runs`: request fingerprint/key, parent run, frozen provider/model, adapter/prompt/schema/policy versions, selected mode, effective ceilings, portfolio revision, progress events, terminal state, measured usage and estimated/reserved costs.
- `agent_tool_calls`: `(run_id, call_id)` identity, argument fingerprint and cached result. M2 allowlists `portfolio_read_v1` and `portfolio_preview_v1`; M3 adds the read-only `market_valuation_read_v1`. The existing portfolio preview key also deduplicates a tool whose response was interrupted.
- `app_settings`: singleton, revision-guarded analysis default.

See [the generated ERD](ERD.md). Migration `0007` is additive. Existing portfolio tables and historical records are preserved.

One PostgreSQL advisory lock serializes chat and workbook inference. A restart can mark abandoned chat runs interrupted only after acquiring that lock; it closes dangling canonical tool calls, rejects pending previews and retains uncertain cost reservations. Native OpenAI retries are disabled. Only normalized transient rate/service failures retry, within the original attempt/deadline allowance. Cancellation, quota, invalid output and capability/configuration failures never trigger provider fallback.

OpenAI uses Responses with `store:false` and encrypted reasoning continuation. Provider-native input/output stays in a private provider/model/adapter-scoped continuation with the exact acknowledged canonical item boundary. Only new canonical items are appended. A configuration change rebuilds from canonical history; foreign continuation is never reused. Tool arguments execute only after a complete terminal model response, never from partial argument deltas. Streamed text is provisional until completion.

## Limits and cost estimates

| Mode      | Model attempts | Tool attempts | Whole-run deadline | Output tokens per attempt |
| --------- | -------------: | ------------: | -----------------: | ------------------------: |
| Quick     |              3 |             4 |         45 seconds |                     2,048 |
| Standard  |              8 |            12 |        120 seconds |                     4,096 |
| Extensive |             16 |            24 |        300 seconds |                     8,192 |

The backend clamps each mode to the `LLM_MAX_*` and timeout settings in `.env.example`. Input size is bounded; history is never silently truncated. If full, start a new conversation. Browsers cannot raise deployment ceilings or edit keys. Metadata identifies limited/failed work and its reason.

Optional `LLM_MAX_RUN_COST_USD` and `LLM_DAILY_BUDGET_USD` require operator-maintained `LLM_INPUT_USD_PER_MILLION`, `LLM_OUTPUT_USD_PER_MILLION` and `LLM_PRICE_VERSION` for OpenAI. Use conservative rates for the configured model, including reasoning/output pricing. These are estimates, not provider billing guarantees. Without rate metadata, cost is unknown and capped inference fails before dispatch. Fixture inference has explicit zero cost.

Before each attempt, reserve a conservative byte/token upper bound for history, native continuation, instructions, tool schemas and protocol overhead plus the output ceiling. Reconcile known usage; retain reservations for missing usage, transport failures and cancellations. The UTC-day ledger survives process restart. Budgets count pending reservations and are protected by a database lock.

**M1 workbook limitation:** paid workbook parsing is disabled when these chat cost caps are enabled. The separate M1 parser does not yet share per-attempt monetary accounting and is not permitted to bypass a deployment budget. Fixture workbook imports remain available. Uncapped OpenAI workbook parsing retains its existing bounded M1 behavior.

## Versioned API

- `GET/PATCH /api/v1/settings/analysis` (PATCH: version 1, expectedRevision, defaultAnalysisMode).
- `GET/PATCH /api/v1/chat/sessions/:context` (PATCH: version 1, expectedRevision, draft).
- `POST /api/v1/chat/sessions/:context/runs`: version 1, UUID idempotencyKey, message, optional analysisMode and parentRunId. Returns the saved run; replay never dispatches another model call.
- `POST /api/v1/chat/sessions/:context/reset`: archive current conversation.
- `GET /api/v1/chat/runs/:id`: public run metadata, without native continuation.
- `GET /api/v1/chat/runs/:id/events?after=N`: persisted SSE event replay and terminal notification. Disconnection alone does not cancel a run.
- `POST /api/v1/chat/runs/:id/cancel`: explicit cancellation request.
- Existing `/portfolio/changes/:id/confirm` and `/reject` remain the only financial decision routes.

Mutations use the same-origin Next proxy, bounded bodies and backend origin rejection. Keys stay exclusively in backend/worker environment. No paid call is required for tests.

## Verification

Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm docs:erd:check`, `pnpm test`, `pnpm build` and `docker compose config --quiet`. With a disposable database, set `TEST_DATABASE_URL` and run `pnpm test:integration`. With an isolated fixture Compose project, set `E2E_BASE_URL` and `E2E_ALLOW_PORTFOLIO_WRITES=1`, then run `pnpm test:e2e`. Browser tests run serially because this is one portfolio with one global inference lock.

Offline coverage includes covered-call cash/signs and confirmation, clarification, mode precedence/ceilings, provider key/capability errors, canonical/native continuation, malformed/partial streams, cancellation/refusal, bounded transient retries, durable idempotence, concurrent-run exclusion, cost reservations, restart recovery, preference/draft persistence and narrow-screen navigation. OpenAI checks use mocked Responses streams; they do not establish live provider availability or quality on arbitrary user wording.

OpenAI adapter references: [function calling](https://developers.openai.com/api/docs/guides/function-calling), [Responses streaming](https://developers.openai.com/api/docs/guides/streaming-responses). These document native adapter behavior only; deterministic portfolio and confirmation rules remain application-owned.

## Local acceptance — 2026-10-31

Passed: 83 unit tests, 21 PostgreSQL integration tests, 14 serial browser tests, strict TypeScript, lint, formatting, ERD freshness, Compose configuration validation and production Docker builds/startup checks. Browser writes used a fresh isolated fixture database; no user portfolio records were changed. The local application was updated using the tested images and its existing database volume. Health is ready; the retained portfolio revision is 2, with its last portfolio commit predating deployment.

No additional paid OpenAI verification was performed. Native Responses streaming/continuation behavior was checked with mocked HTTP streams. Live availability and arbitrary-workbook/model interpretation quality remain outside these offline checks.

### Chat schema repair — 2026-10-31

A live rejection exposed a gap in the initial mocked acceptance tests: Zod 4 emitted `oneOf` for the operation discriminated union, which OpenAI rejected as `invalid_function_parameters` at `tools[1].parameters`. The tool schema now represents the proven-disjoint `kind` variants as `anyOf`, with the discriminator first, literal values as enums, and every object closed/required. Original Zod operation validation remains authoritative. Regression tests inspect the actual serialized provider request, not only mocked successful responses.

Invalid-request errors now identify application request/schema failures, retain only safe provider-code/parameter/request-ID diagnostics, and avoid duplicate no-change notices. Existing failed runs remain historical records. A live synthetic greeting using the corrected schema completed successfully (4,739 input tokens, 5 output tokens, no tool calls). No portfolio data was sent or portfolio change confirmed by that check. See the [official supported-schema documentation](https://developers.openai.com/api/docs/guides/structured-outputs).

### Late reported trades

A trade operation may carry an optional ISO calendar `transactionDate`, independently of its ledger `effectiveAt`. Chat assigns the recording time itself; users do not need an exact UTC execution time. Relative dates use America/Vancouver and the original message timestamp. A late report updates current holdings and cash only after preview and confirmation; it does not replay or rewrite earlier snapshots. Closing P&L uses the currently recorded basis, not reconstructed historical basis.

Dated trades require `tradeNotAlreadyIncluded: true` on confirmation, collected through a preview checkbox. If a snapshot already includes the trade, do not apply the delta again. Existing confirmed notes remain notes; they neither apply the trade nor erase its source facts from subsequent clarification. The application stops inference after a successful preview and explicitly labels it unrecorded until human confirmation.

This is an additive JSON operation field in existing preview/event storage; no database column or migration changes. Direct API requests with a ledger effective time before the current boundary remain rejected. Confirmation is transactional, revision-checked and idempotent.

Late-report verification: 87 unit tests and 23 PostgreSQL integration tests passed, along with typecheck, lint, formatting, ERD freshness, Compose configuration validation and production Docker builds. Mocked-preview browser checks passed at 1440px and 390px: confirmation stays disabled until the inclusion acknowledgement, and the page has no horizontal overflow. No actual portfolio changes were confirmed. The full browser suite and a new live OpenAI late-trade run were not performed for this repair; the targeted browser check uses fixture responses.

### Panel and repeated-report usability

Drag the divider (or focus it and use arrow keys) to resize Advisor. Desktop panes scroll independently; narrow screens use a bottom panel with adjustable height. Sizes persist in this browser. Mode changes save automatically, with visible save errors. Older portfolio snapshot copies are omitted only from inference context; canonical evidence and all messages remain stored. Native continuation is rebuilt when that projection changes. Current state is supplied on every attempt, and the existing input/cost ceilings remain unchanged. Saved run failures remain visible after reload.

### Capital visual direction and workbook confirmation

The approved light direction uses white surfaces, dark ink, forest-green accents and serif section headings. Resize targets retain keyboard/touch support with a thin visible rule and small grip. No sample market valuations or performance numbers from the mockup are introduced.

A repeated upload of an already-confirmed workbook stays idempotent. Its review explains that it was already applied and offers **Review this workbook again**, using the existing baseline-restore preview API against the current revision. This is a new full replacement, never an automatic repeat commit. The replacement acknowledgement is required again. Pending previews explain the unchecked acknowledgement or expiration instead of leaving users with an unexplained disabled action.

### Selected holding context and Capital layout

Holdings are grouped by account with collapsible rows and search. **Ask Advisor** selects an exact account/instrument pair and shows a removable context chip in the docked composer. Selection survives navigation and reload in this browser and is cleared after confirmation or with the clear control. Symbols alone never disambiguate option contracts or accounts.

The version-1 chat request accepts optional `holdingContext: { accountKey, instrumentKey }`. It participates in the idempotency fingerprint and is persisted on the canonical user message. The Advisor resolves it against current holdings before inference and rejects missing holdings or mismatched trade proposals. No stale quantity, cost or cash is copied from the browser. “Sold 3 shares” supplies quantity and direction, while the selected holding supplies account/security; missing execution price and fees are still clarified. Average cost is never substituted for execution price. Preview, revision checks and human confirmation remain mandatory. This additive JSON metadata needs no database migration.

The screen follows the approved light mockup's narrow icon rail, white surfaces, serif headings, account groups, muted separators and bottom-docked composer. Monograms identify securities without adding external logo requests. Unsupported market values/P&L from the illustrative mockup are omitted.

### Account scope and conversation following

**Ask Advisor** beside an account selects that account without selecting a security. The existing context metadata has an optional `instrumentKey`; saved holding selections remain compatible. Account scope supplies the account for trade reports, but a missing ticker still requires clarification. Cross-account trade proposals remain rejected.

Selection is a default scope for read-only questions, not a topic restriction. An explicit ticker replaces the selected ticker. Simple “how many TSLA?” queries use a deterministic decimal-safe share count from current records, defaulting to the selected account. “Across all accounts” overrides that scope. Replies label the account scope, net share quantity and record timestamp/revision; options are excluded. A closed selected holding does not block these questions. Other wording remains handled by Advisor with the same scope instructions.

New sends follow the latest conversation content, and streamed replies stay in view when already following. Scrolling upward pauses following and exposes **Latest message**; starting a new conversation resets its viewport. No database schema change or paid test is required.

### PR verification — 2026-10-31

The full browser suite passed: 18 tests on a fresh, isolated Compose project with fixture inference, a separate PostgreSQL volume and port 3106. This closes the earlier targeted-only browser verification gap. Latest unit/integration totals are 93 and 25 respectively; typecheck, lint, formatting, ERD freshness, production builds and service health checks also passed. No live OpenAI call or real portfolio change was made during PR verification. The existing limitation on paid M1 workbook parsing when chat monetary caps are enabled remains documented above.
