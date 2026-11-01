# 15 — User Selectable Analysis Modes

## 1. Product behavior

M²D offers **Quick**, **Standard**, and **Extensive** analysis. **Standard** is the initial default. The owner chooses a mode beside the chat input or before a manual scan/research request, and can save a preferred default for future interactive requests.

| Mode | Analysis scope | Intended use | Resource allowance |
|---|---|---|---|
| Quick | Address one focused question using current portfolio context and relevant existing evidence; refresh required quotes/data before a trade conclusion | Position/status questions, one focused trade-management check, straightforward record parsing | Smallest research and compute allowance |
| Standard | Check relevant holdings, current market evidence and catalysts; calculate risk/reward and compare a small number of practical alternatives | Routine trade evaluation and daily portfolio decisions | Balanced default allowance |
| Extensive | Investigate broader supporting and contrary evidence, compare strategies/scenarios, and inspect assumptions and portfolio consequences | Deeper thesis research, complicated option decisions and portfolio reviews | Largest bounded allowance |

These are analysis-depth profiles, not promised completion times, prices or accuracy levels. Extensive does not guarantee a better answer. Simple bookkeeping or deterministic queries can finish without spending the selected LLM budget. Available research/strategy tools still depend on the implemented milestone and data entitlements; a mode does not claim unavailable functionality exists.

## 2. Invariants in every mode

- Identical quote/session freshness, source provenance, deterministic financial calculations, signal qualification and position limits.
- Identical preview/confirmation, revision checks, transaction history and no-broker/no-execution boundaries.
- Quick can reuse still-valid cached evidence; it cannot use stale prices as live data to save time.
- If required evidence cannot be obtained within the allowance, report the missing information and limited/unfinished scope. Do not label an interrupted scan as a completed no-signal scan.
- All answers lead with a compact conclusion, action/trigger when supported, key evidence and primary risk. Extensive exposes more evidence, alternatives and scenarios as expandable detail; it does not force a long answer.

## 3. Selection and defaults

Use `analysisMode: "quick" | "standard" | "extensive"` in application contracts. For interactive requests resolve: explicit request selection, then saved `app_settings.default_analysis_mode`, then `ANALYSIS_MODE_DEFAULT` (initially `standard`). Reject invalid values.

Save a preference in the existing single-owner workspace model, without adding users, tenants or authentication. A preference change affects subsequent interactive requests only. It does not change an active run, an existing job's selected mode, the provider, the model or credentials. Preference changes are not portfolio mutations and need no portfolio preview.

Each scheduled AI job stores an explicit mode when created/configured. An omitted new-job choice can be initialized from the current default once, then persisted. Every job run resolves that stored mode against the current versioned policy and deployment ceilings. Deterministic monitoring checks remain independent of LLM depth and cannot be delayed behind Extensive research.

A deeper follow-up is an explicit new request, optionally recording `parentRunId`. Reuse only evidence that remains valid and refresh the portfolio revision/quotes as necessary. Do not automatically escalate a Quick request to a higher mode or continue spending after its budget is exhausted.

## 4. Provider independence

The mode policy lives in `packages/agent`; it chooses an application work plan and limits before calling `LlmProvider`. `LLM_PROVIDER` and `LLM_MODEL` remain separate explicit settings. Version 1 uses the same configured provider/model across all three modes.

The mode is not a direct alias for a provider's native reasoning parameter. Adapters may map optional supported tuning in a later verified implementation, but must not assume an identical control exists across OpenAI, Gemini and Claude. The core difference in v1 is scope, evidence collection and bounded work, not an undocumented model feature. No extra provider or orchestration framework is required.

## 5. Initial execution policy

Define one validated, versioned mode policy in `packages/agent`. Initial engineering defaults:

| Limit | Quick | Standard | Extensive |
|---|---:|---:|---:|
| Maximum model-call attempts per run | 3 | 8 | 16 |
| Maximum tool-call attempts per run | 4 | 12 | 24 |
| Whole-run deadline, seconds | 45 | 120 | 300 |
| Maximum output tokens per model call | 2,048 | 4,096 | 8,192 |

These are upper bounds, not quotas to consume or user-facing speed guarantees. Retry attempts count toward the same allowance. Tool batch sizes, input/output size and concurrency remain bounded by the tool registry. Count any native provider-specific usage under the cost policy; do not assume reported token categories are identical.

Deployment ceilings from `12_OPERATIONS.md` can lower any profile. Resolve each effective limit as the minimum of the mode policy, operator ceiling and remaining applicable run/daily/provider allowance. Per-request timeouts cannot exceed the run's remaining deadline. Configured cost caps apply across all modes and concurrent work; Extensive cannot raise or bypass them. If a profile is capped, retain the selected mode label and disclose its effective limits rather than silently renaming the mode.

Freeze `analysisMode`, `modePolicyVersion` and `effectiveLimits` when the run starts. Record provider/model and source/portfolio references separately. Persist `analysisCompleteness: "complete" | "limited"` and `limitReasons` alongside the actual terminal status. Research coverage and provider status are distinct: a model refusal, truncated generation, cancellation or deadline failure cannot be reclassified as successful analysis merely because some text exists.

## 6. UI and API contract

- Selector labels: **Quick / Standard / Extensive**, with brief scope/resource hints and Standard initially selected.
- Request examples: `{ "message": "Review my option exposure", "analysisMode": "standard" }`; manual scans/research use the same mode enum.
- `GET /settings/analysis` exposes default and public mode summaries; revision-guarded `PATCH /settings/analysis` updates the saved default only. Neither endpoint edits API keys or operator ceilings.
- `run_started` exposes mode, effective limits and cap warnings. The answer/run details retain the mode and report final completeness, reasons and measured usage when available.
- Provide progress and cancellation for longer work. "Run deeper" launches a separately selected mode; it does not silently modify a running request.
- Output length is separate from depth: the conclusion remains concise; details can be expanded or explicitly requested.

## 7. Implementation and acceptance

M2 implements selection, saved defaults, policy resolution, metadata, cancellation and fixture/OpenAI behavior. Research and strategy capabilities expand at their existing milestones; Extensive is bounded by whatever tools actually exist.

Verify default/override precedence, invalid modes, preference persistence, scheduled-mode independence and immutable active runs. All three profiles must pass the same freshness, financial validation and portfolio-confirmation cases. Test that deployment/cost caps cannot be raised by request fields, that retries consume the original allowance, and that Quick's exhausted budget yields limited/unfinished analysis without automatic escalation. Fixture runs exercise each mode without real API keys or timing claims.

M2 implementation notes and the separate M1 workbook accounting limitation: [M2_CHAT.md](M2_CHAT.md).

### Search retrieval accounting

An uncached semantic search query made by Advisor consumes one model attempt and records embedding usage/cost in that run; cached query vectors do not. Query embeddings respect the existing run deadline/cancellation, request timeout and run/daily cost ceilings. Explicit indexing from Research is separately bounded by durable daily input-byte reservations and the same configured daily inference cost gate. Indexing is never an automatic analysis-mode escalation. The search UI exposes partial coverage and unavailable/error states rather than silently changing retrieval/provider behavior.


## Chat presentation

The conversation toolbar groups **Reset conversation** with the automatically saved analysis-mode selector. Reset starts a fresh conversation for the current function and clears its unsent draft, using the existing reset API. The composer retains Enter to send, Shift+Enter for a newline, busy-state guards and confirmation previews.

Chat, streaming text and workbook conversations share a Markdown renderer (`react-markdown` with `remark-gfm`) for headings, emphasis, lists, code, quotes, tables and links. These libraries replace the narrow citation-only formatter with a standard parser. Raw HTML is disabled, default unsafe-URL filtering remains enabled, and Markdown images display their alt text without fetching remote content. Internal research links retain client-side navigation and citation fragments. Long tables and code blocks scroll within the message rather than widening the panel. This is a display change; canonical messages, inference policies, financial gates and API contracts are unchanged.

Presentation verification: 198 unit tests and 38 browser tests passed, with three targeted desktop/mobile and panel tests repeated after the final visual refinements. Typecheck, lint, formatting and the web Docker build passed. The web service was redeployed; read-only health/navigation checks confirmed portfolio and saved preferences were unchanged. No new inference call was needed for this rendering-only change.


## Per-send Advisor settings

Each send starts a separate run with an immutable selected mode, output language and effective limits. Model attempts, tool calls, elapsed time and run cost begin afresh for that send; retries within it consume the same allowance. Daily chat/research inference accounting remains cumulative across conversations under the existing UTC ledger and deployment caps. **Usage for this reply** shows the latest run only; **Daily usage (UTC)** is separate and includes reservations. Unpriced usage is marked incomplete. Earlier history still counts toward model input usage.

Mode and **Reply language** controls can change during a reply: they affect the next send and never alter the active run. Selections automatically persist as workspace preferences; they are not conversation settings. English is the initial language; 简体中文 is also supported. Language applies to new Advisor replies; UI controls, source quotations, tickers, numbers and citation URLs retain their original representation. Deterministic share-count replies honor language without inference; other fixture replies remain canned offline examples.

Canonical conversation history and compatible provider continuation are retained between sends and when settings change. **Reset conversation** explicitly archives the old conversation and starts a new one. Migration 0020 adds the workspace language preference and per-run language snapshot; older runs have unknown/null language rather than an invented label. Request fingerprints include explicitly requested language, so changing it on a reused request key is rejected.
