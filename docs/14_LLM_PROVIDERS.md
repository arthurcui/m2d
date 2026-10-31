# 14 — LLM Provider Architecture

## 1. Current decision

**M²D uses the OpenAI API directly, with `OPENAI_API_KEY` supplied through the backend/worker environment.** ChatGPT sign-in, subscription sessions, OAuth callbacks, browser cookies and imported ChatGPT credentials are excluded from model access. This decision, made on 2026-10-30, supersedes earlier conversation proposals for ChatGPT sign-in.

The inference layer must allow Google Gemini and Anthropic Claude to be added without changing portfolio accounting, risk calculations, research storage, tool execution or the UI contract. Implement OpenAI and fixture adapters first; the future adapters are extension points, not working integrations. The exact model is a runtime choice through `LLM_MODEL`.

This chapter specifies the implementation boundary. It does not provision an API key, select an account entitlement, or authorize live API usage. M²D's local/private access model remains defined by the existing architecture.

## 2. Responsibilities

| Component | Owns |
|---|---|
| `apps/web` | M²D chat and status UI; sends requests to M²D API; receives normalized events |
| `packages/agent` | Intent, context assembly, prompts, bounded tool loop, budgets, validation and persistence orchestration |
| `packages/llm` public contract | Provider-neutral requests, outputs, streaming events, capabilities and errors |
| `packages/llm` adapters | Native SDK calls, serialization, streaming translation, usage normalization and private continuation |
| M²D tool registry | Allowlisted portfolio/research/market reads and mutation previews; no arbitrary execution |
| Portfolio and risk packages | Deterministic accounting, quantities, money, exposures, payoff and signal eligibility |
| M²D persistence | Canonical conversation, evidence, run history, tool results and provider-scoped continuation |

Provider SDK imports and native types stay inside adapter modules. The composition root in `api`/`worker` selects the provider; domain, risk, strategy and UI modules never import an SDK. An adapter receives no database mutation authority or tool executors. It returns tool requests to the M²D agent, which validates and executes allowed tools.

### Intended module layout

- `packages/llm/src/contracts.ts` — M²D-owned types and errors.
- `packages/llm/src/factory.ts` — explicit provider registry and configuration validation.
- `packages/llm/src/adapters/openai.ts` — first real API adapter.
- `packages/llm/src/adapters/fixture.ts` — deterministic offline adapter.
- `packages/llm/src/adapters/gemini.ts` — add only when implementing Gemini.
- `packages/llm/src/adapters/anthropic.ts` — add only when implementing Claude.

Avoid empty production stubs that imply future providers work. An unimplemented selection returns `LLM_PROVIDER_NOT_IMPLEMENTED`.

## 3. Provider contract

The following is a design sketch; the request/result types are specified by the tables below and must become validated M²D types at implementation.

```ts
type LlmProviderId = "openai" | "gemini" | "anthropic" | "fixture";

interface LlmProvider {
  readonly id: LlmProviderId;
  capabilities(model: string): ModelCapabilities;
  generate(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
  stream?(
    request: ModelRequest,
    signal?: AbortSignal
  ): AsyncIterable<ModelEvent>;
}
```

### Model request

| Field | Contract |
|---|---|
| `runId`, `requestId` | M²D correlation identifiers; unique per logical run and individual attempt |
| `analysisMode`, `modePolicyVersion` | Application policy metadata resolved by the agent; not provider-specific reasoning values |
| `model` | Explicit model ID; no hidden upgrade or provider substitution |
| `instructions` | Trusted M²D system/developer policy, separate from retrieved documents |
| `history` | Ordered canonical text, tool-call and tool-result items with stable IDs and evidence references |
| `tools` | M²D names, descriptions and validated JSON schemas; no executable callbacks or secrets |
| `outputSchema` | Optional validated schema for the final application output |
| `requiredCapabilities` | Features this request requires; reject unsupported combinations before dispatch |
| `limits` | Remaining model-call and tool-call attempts including retries, request/run deadline, output-token bound and configured cost allowance |
| `continuation` | Optional provider/model/adapter-version-scoped opaque payload plus last acknowledged canonical item ID |

Canonical history must represent tool calls and results, not only `{role, text}`. An adapter serializes history and continuation exactly once: the acknowledged item boundary prevents both resending already represented items and dropping newly returned tool results.

### Model response and stream

| Field | Contract |
|---|---|
| `status` | `completed`, `tool_calls`, `refused`, or `incomplete`; transport failures use normalized errors |
| `items` | Newly produced canonical text/tool-call items, preserving call IDs and order |
| `structuredOutput` | Parsed unknown value until the application validates its schema and domain constraints |
| `usage` | Reported input/output/cached/reasoning usage when available; missing values are unknown, not zero |
| `providerRequestId` | Sanitized diagnostic identifier, never an authorization value |
| `continuation` | Updated opaque continuation for the same provider/model/adapter version |

Streaming normalizes text deltas, complete tool requests, usage, terminal status and errors. Partial tool-argument deltas are buffered inside the adapter; they cannot execute tools. The adapter exposes a completed tool-call batch only after a valid tool-call response boundary. A truncated stream fails or returns `incomplete`; it does not create a valid decision from partial text. The API maps model events to its existing M²D SSE events and publishes actionable/preview cards only after validation.

## 4. Capabilities and validation

Capabilities are verified for the selected **model**, not assumed from the provider name: function/tool calling, schema-constrained output, streaming and supported input modalities. Required schema constructs and combinations must be checked as well as feature booleans. Unknown or unsupported required capabilities return `LLM_CAPABILITY_UNSUPPORTED`; do not silently remove a tool or output constraint.

M2 requires text, typed tool calls and structured parsing. Image/document model input is a later optional capability; existing document extraction can continue to produce text. Provider-specific reasoning parameters stay in adapter-owned configuration rather than becoming universal arguments that some models silently ignore.

All tools and returned objects pass M²D runtime validation even when the API constrains JSON. Correct JSON is not proof of correct position size, currency, option identity, price freshness, or financial reasoning. The agent cannot bypass the existing preview, confirmation, revision and transaction rules.

## 5. Conversation and tool continuity

M²D keeps two distinct records:

1. **Canonical application history:** user and assistant text, tool calls/results, source IDs, portfolio revision and accepted outputs. This remains usable when choosing another provider.
2. **Adapter-private continuation:** required native response items, IDs, signatures or other API continuation metadata. Persist only what is needed, scope it to provider/model/adapter version, keep it out of public responses/logs, and never place API credentials in it.

The distinction addresses actual provider differences:

- OpenAI tool results match the returned call IDs; relevant reasoning response items must also be preserved when continuing applicable reasoning-model tool calls. See [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling).
- Gemini's continuation can require exact thought/signature preservation when maintaining state locally; its stateful mode can manage continuation using its own reference. See [Gemini thinking](https://ai.google.dev/gemini-api/docs/thinking).
- Claude represents tool use and results as content blocks with matching IDs and ordering requirements. See [Claude tool-call handling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls).

Only the adapter interprets these details. Do not decode private reasoning state or treat it as a user-facing explanation. Changing provider, model or incompatible adapter version starts a new run from canonical M²D context. Never forward an OpenAI response ID or opaque payload to Gemini/Claude. A new run can preserve relevant validated evidence without claiming identical answers or uninterrupted native reasoning state.

Tool execution stays in M²D. Replayed calls use `(runId, toolCallId)` plus the existing domain idempotency/revision guards. A retry cannot commit a financial change: commit routes remain outside the model's tool set. Cancellation stops new dispatches and propagates to active requests/tools; already received evidence remains recorded with the run's actual terminal status.

## 6. Provider implementation order

| Selection | Access | Release scope |
|---|---|---|
| `openai` | OpenAI Responses API; `OPENAI_API_KEY` | M1 workbook extraction; full chat/tool behavior at M2 |
| `fixture` | Deterministic stored scenarios; no network or credentials | M0 scaffolding and offline tests; full tool behavior at M2 |
| `gemini` | Google Gemini API; planned `GEMINI_API_KEY` | Future adapter and contract tests |
| `anthropic` | Anthropic Claude API; planned `ANTHROPIC_API_KEY` | Future adapter and contract tests |

Use the native official SDK/API inside each adapter when implementing it. Do not assume an OpenAI-compatible endpoint captures every provider's tool, schema, streaming and continuation behavior. No external agent framework or extra inference gateway service is required by this design.

For OpenAI, the official TypeScript SDK supports the Responses API and environment-based key configuration. See [OpenAI TypeScript SDK](https://developers.openai.com/api/reference/typescript). Model IDs and model capabilities must be verified at implementation/configuration time rather than copied permanently from examples.

## 7. Environment and credential handling

Normal configured operation:

```dotenv
LLM_PROVIDER=openai
LLM_MODEL=<explicit-supported-model-id>
OPENAI_API_KEY=<server-side-secret>
```

The angle-bracket values above are explanatory placeholders. The committed example keeps secret/model values empty and documents how to configure them. Future providers use `LLM_PROVIDER=gemini` or `LLM_PROVIDER=anthropic` after implementation; only the selected provider's key is required. Offline development explicitly uses `LLM_PROVIDER=fixture` and `LLM_MODEL=fixture-v1`.

Load real keys only in `api` and `worker` runtime environments. Never expose them through `NEXT_PUBLIC_*`, frontend bundles, browser storage, source control, build arguments, container images, tool arguments or logs. A cloud secret facility may inject the same environment variables. OpenAI's [API authentication guidance](https://developers.openai.com/api/reference/overview) specifies server-side secret handling and environment/key-management loading.

Startup validates configuration without making a paid request. A missing selected key/model leaves AI unavailable with a clear setup error; manual portfolio functions keep working. No ChatGPT account login or subscription eligibility check is part of M²D inference. Do not silently switch to fixture or another paid provider on authentication, quota or availability failure.

## 8. Reliability, cost and observability

- Bound request duration, whole-run duration, output tokens, model-call attempts, tool-call attempts and concurrent runs. Apply the Quick/Standard/Extensive profiles in `15_ANALYSIS_MODES.md` under deployment ceilings; Standard starts at 8 model-call attempts, including retries, and separately 12 tool-call attempts. The agent owns the shared remaining budget across all attempts. Modes do not switch provider/model or assume identical native reasoning controls; v1 uses the same configured `LLM_MODEL` with different application work plans and limits.
- When cost caps are configured, reserve conservative estimated cost before dispatch, including concurrent in-flight work, then reconcile reported usage. Store the price-table version and label estimates. If price data is unavailable, a cost-capped request cannot be treated as zero cost; stop with a clear budget/price-data status. An application estimate is not an exact provider billing guarantee.
- Keep optional daily cost accounting durable across process restarts. Count interactive and scheduled runs under the same selected policy. Show when a cost cap is unset; never imply the OpenAI API is free because a ChatGPT subscription exists.
- Normalize authentication, exhausted quota, rate limit, timeout, unavailable, invalid output, unsupported capability, unimplemented provider, cancellation and exhausted-budget conditions. Preserve safe request IDs and error codes, redact prompts/account data from routine diagnostics as appropriate, and never log secrets.
- Use one bounded retry policy. Configure native SDK retries explicitly so SDK and application retries do not multiply. Retry transient rate-limit/server/network failures only within the remaining deadline and allowance; do not repeatedly retry invalid credentials, exhausted quota, unsupported features, model refusal or malformed configuration. A timed-out request may already have consumed API usage; record uncertainty instead of assuming it was free.
- No automatic cross-provider fallback in v1. A later routing policy must explicitly identify provider/model, data destination and budget; provider substitution cannot bypass failed financial validation.

Record `provider`, `model`, `analysisMode`, `modePolicyVersion`, `effectiveLimits`, `analysisCompleteness`, `limitReasons`, `adapterVersion`, `promptVersion`, `schemaVersion`, `portfolioRevision`, evidence references, reported usage, estimated cost/price version, latency, request ID, retries, terminal status and validation outcome. Keep provider payload details private to the adapter/run persistence. UI status reports configuration and availability without reading or returning keys.

## 9. Acceptance criteria

The implementation passes the detailed tests in `10_TESTING.md` and demonstrates:

1. Configured OpenAI inference works through server environment credentials with no ChatGPT login/session dependency.
2. The fixture adapter exercises the same agent contract offline; changing the registered provider does not change portfolio/risk code or UI payloads.
3. A multi-step tool run preserves call matching, order and native continuation without duplicating canonical history.
4. Unsupported required capabilities, invalid JSON/arguments, refusal, truncation and cancellation produce explicit outcomes and no actionable/committed financial output.
5. Model/tool loops, retries, concurrent dispatch and configured cost accounting remain within the same run policy.
6. Runtime keys never enter browser bundles, returned status, public SSE events or stored credentials; unselected providers need no keys.
7. Gemini/Claude can be added by implementing and registering an adapter plus passing the same contract suite. Provider-specific tests verify any additional continuation/schema semantics before enabling each adapter.

This is a design revision. Runtime conformance is established only when the relevant implementation milestone is built and tested.

## M1 workbook scope extension — 2026-10-31

User authorization advances only workbook interpretation into M1. `packages/llm` now implements a provider-neutral, one-response structured extraction contract and a native OpenAI Responses adapter, with explicit offline fixtures. `packages/agent` owns workbook context, prompt, output schema, evidence grounding and deterministic validation. There are no tools, streams, model-controlled commits, automatic fallbacks or hidden retries. Every clarification starts a fresh stateless extraction using the original workbook plus the full user clarification; no native continuation is discarded because there is no tool loop in this flow. M2 still owns general chat, incremental parsing, canonical tool history/opaque continuation and analysis modes. See M1 notes for exact limits and audit behavior.
