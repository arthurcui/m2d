# 06 — AI Agent Engine (Independent)

## 1. Goals
Build a **small custom orchestration loop**; do NOT use OpenClaw, LangChain, AutoGen or a generic autonomous-agent platform as the architecture. LLM provides analysis and natural-language interaction; typechecked tools and code own all state and numeric truth.

### Loop
`intent classification -> context assembly -> bounded plan -> typed tool calls -> evidence validation -> risk/signal rule evaluation -> response -> persisted run metadata`.

### Run contexts
- `USER_CHAT` — user question or an explicit edit instruction.
- `SCHEDULED_MONITOR` — triggered by timer, position or data update; no user input required.
- `RESEARCH_REFRESH` — new filings / source event.
- `SIGNAL_REVIEW` — evaluate active plans against new quotes and material changes.

## 2. Contract
`LlmProvider.generate(request, signal?)` is the provider-neutral inference boundary defined in `14_LLM_PROVIDERS.md`. `packages/llm` implements the OpenAI Responses API adapter and an offline fixture adapter first; Gemini and Anthropic Claude adapters can be added later. The OpenAI adapter uses `OPENAI_API_KEY` from the backend/worker environment, with `LLM_PROVIDER` and `LLM_MODEL` selecting the transport and model. ChatGPT sign-in, OAuth, browser sessions and subscription credentials are excluded.

The agent owns context assembly, the tool loop, validation, run limits and persistence. Adapters own provider request/response formats, streaming conversion and continuation state. Canonical M²D messages/tool records remain portable; opaque state is scoped to one provider/model/adapter version and is never forwarded to another provider. No provider SDK types escape adapter modules.

Check required model capabilities before calling. Distinguish completed output, tool requests, refusals and incomplete output; validate tool arguments and structured answers before use. Resolve Quick, Standard or Extensive through the versioned mode policy in `15_ANALYSIS_MODES.md`, then apply deployment and remaining budget ceilings. Standard initially permits 8 model-call attempts, including retries, and separately 12 tool-call attempts; Quick and Extensive use their own bounded profiles. Add token/time caps, configured cost caps, tool timeouts, cancellation, and failure summaries. Unit tests never require live API keys. Invalid, refused or incomplete output cannot become a confirmed portfolio operation or an actionable trade plan.

Mode is application policy, not a provider-specific prompt keyword. Freeze the chosen mode, policy version and effective limits for the run. Every mode shares the same evidence, financial-validation and confirmation rules; deeper analysis requires a new explicitly selected run rather than automatic escalation.

## 3. Tool registry
Read-only:
- `portfolio.get_overview`, `portfolio.get_accounts`, `portfolio.get_positions`, `portfolio.get_cash`, `portfolio.get_history`, `portfolio.get_expirations`
- `market.get_quote`, `market.get_bars`, `market.get_option_chain`, `market.get_fx`, `market.get_market_calendar`
- `risk.get_exposure`, `risk.get_concentration`, `risk.run_stress`, `risk.evaluate_position`
- `research.search_filings`, `research.search_documents`, `research.get_company_facts`, `research.compare_revisions`
- `strategy.screen_symbols`, `strategy.evaluate_trade`, `signal.get_active`, `performance.get_signal_stats`
Mutation-preview only:
- `portfolio.preview_natural_language_change`
- `portfolio.preview_excel_replacement` (uploaded file already staged server-side)
- `watchlist.preview_change`
- `rule.preview_change`

**Never expose** `execute_trade`, `broker.connect`, `portfolio.commit_without_confirmation`, raw SQL, shell, arbitrary HTTP request or path read as agent tools. A separate human UI confirm call commits previews.

## 4. Tool execution guardrails
- Zod schemas for args/results, input length and decimal ranges; deterministic error codes; explicit tools-version.
- User input, news/PDF content and search snippets are data, not trusted instruction.
- LLM may propose `BUY`, `SELL`, `HOLD`, `ROLL`, `HEDGE`, `NO_TRADE` but only strategy service can label a plan `ACTIONABLE` after validation.
- Never instruct execution without a quote source, source timestamp, fill/liquidity assumptions, target, stop/invalidation, position sizing and main risk.
- If no data: say exactly what is unavailable; do not silently use memory prices.
- Display if an analysis is a conditional plan, not immediate execution guidance.

## 5. Structured agent outputs
`AgentAnswer`:
```json
{
  "summary": "No actionable setup; options chain is delayed",
  "asOf": "2026-10-30T20:00:00Z",
  "marketSession": "REGULAR",
  "dataQuality": "DELAYED",
  "observations": [],
  "recommendations": [],
  "questions": [],
  "citations": [{"sourceId":"source-123", "label":"SEC filing"}],
  "runId": "..."
}
```
`TradeCandidate` and its lifecycle are specified in `07_TRADING_RISK.md`. Return no recommendation rather than fabricating a setup.

Run metadata also includes `analysisMode`, `modePolicyVersion`, `effectiveLimits`, `analysisCompleteness` and `limitReasons`. Distinguish limited research scope from a provider's incomplete/failed response. All modes lead with a concise decision and risk; supporting evidence and scenarios can be expanded.

## 6. Context and memory
- Durable factual memory: portfolio state, watchlists, preferences, active strategy plans, prior signals, historical source evidence. Retrieve from DB, not conversational recall.
- User settings: risk tolerance/risk budget, max trade size, maximum option days to expiry, acceptable strategies, scanner cadence and output verbosity.
- Conversation summaries can improve chat coherence but never replace authoritative portfolio records.
- Keep assistant messages concise and trade-decision first; avoid repetitive news and re-alerting unchanged signals.
- Persist provider/model/adapter version, prompt and schema versions, source references, usage, latency, sanitized request IDs and terminal status for each run. Treat provider continuation as adapter-owned private state, never as authoritative financial memory or frontend content. Switching provider starts a new run from canonical context; it does not transfer opaque provider state.

## 7. Continuous improvement is measured, not magic
Record every candidate with immutable feature snapshot, source versions, strategy version and model name. Evaluate subsequent returns using pre-registered entry/exit logic and timestamped future market data. Compare against walk-forward/out-of-sample cohorts. Do not auto-tune on a small sample and claim superior performance.

## Implemented M4 research tools

The four research reads are available through versioned `research_*_v1` contracts; see [M4_RESEARCH.md](M4_RESEARCH.md). They retrieve saved evidence only and cannot initiate external downloads or commit financial changes. Research questions inherit their selected company and cutoff, and the backend clamps all research reads to that historical boundary. Citation document IDs must occur in retrieved evidence. Source statements remain separate from Agent interpretation.
