# M2 — Persistent portfolio Agent

M2 adds conversation-based self-reported portfolio updates. It does not add market feeds, research retrieval, order execution or autonomous monitoring. Existing workbook interpretation and confirmation remain available.

## Use

Start with `docker compose up --build --detach --wait --wait-timeout 180`, then open http://127.0.0.1:3000. The shared Agent panel has a separate PostgreSQL-backed conversation for every navigation function. Enter sends; Shift+Enter inserts a line. Drafts are saved to PostgreSQL after a short debounce, with an immediate browser-local copy. Navigating or closing the panel does not cancel a run. Reload reconnects to saved progress. **Cancel run** explicitly stops inference. **New conversation** archives the previous session and retains its run audit records.

Use Quick, Standard or Extensive to select a work allowance. Standard is initially selected; **Save as default** persists the preference. An explicit request overrides the saved default, then the deployment default. A follow-up is a new run with a parent ID and the explicitly selected mode. Later research and strategy tools remain unavailable regardless of mode.

For a portfolio already containing 100 AAPL shares in a Margin account, an offline example is:

> Sell to open 1 covered call AAPL in Margin, expiry 2026-12-18, strike 200, premium 2, no fees, standard 100-share contract.

The fixture asks for missing details and proposes a negative one-contract position with a USD 200 cash increase. It does not apply the change. Review the exact holdings/cash diff, warnings, effective time and expected revision, then select **Confirm changes**. Repeat confirmation is idempotent. Concurrent ledger changes invalidate stale previews. An interrupted, refused, cancelled or incomplete run cannot leave a confirmable chat preview.

The deterministic fixture supports explicit stock buy/sell, cash deposit/withdrawal and covered-call examples using existing securities/accounts. OpenAI supports the typed operation vocabulary through the same validators. Neither adapter can commit, execute trades or invoke SQL. Unknown prices, fees, accounts or option terms require clarification. Monetary arithmetic remains in the portfolio package. Coverage checks use self-reported holdings, not broker balances.

## Persistence and execution

- `agent_sessions`: context, canonical text/tool history, private continuation and draft/revision. Archived sessions remain in the database.
- `agent_runs`: request fingerprint/key, parent run, frozen provider/model, adapter/prompt/schema/policy versions, selected mode, effective ceilings, portfolio revision, progress events, terminal state, measured usage and estimated/reserved costs.
- `agent_tool_calls`: `(run_id, call_id)` identity, argument fingerprint and cached result. Only `portfolio_read_v1` and `portfolio_preview_v1` are allowlisted. The existing portfolio preview key also deduplicates a tool whose response was interrupted.
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
