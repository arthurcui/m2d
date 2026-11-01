# 13 — Architecture Decision Records

| ADR | Decision | Rationale | Consequence |
|---|---|---|---|
| 001 | Single-user independent system | Personal investment use, minimal friction | No user/tenant/auth modules in initial design |
| 002 | No broker account integration or orders | User enters positions manually or by Excel | Actual fills are self-reported; never assume account state synced. ADR-038 permits market-only IBKR MCP. |
| 003 | Docker-first web/api/worker/postgres | Local reliability and cloud portability | Four services, simple Compose |
| 004 | Modular monolith TypeScript | Faster iteration, shared types and coherent accounting | Clear package boundaries; no early microservices |
| 005 | Postgres as system of record | Consistency, history, transactional full replacement | More runtime than SQLite but good local/cloud parity |
| 006 | Latest baseline + incremental events | Natural language convenience and authoritative Excel reset | Preserve history, no fabricated transactions between baselines |
| 007 | User-confirmed mutation | Avoid wrongly parsed trades or accidental portfolio corruption | Preview/diff and revision checks required |
| 008 | Strict tool registry, custom agent loop | Transparent calculations and controlled reasoning | LLM can't directly write financial state |
| 009 | pg-boss rather than Redis/Kafka | Reliable scheduling with existing Postgres | Worker depends on DB availability |
| 010 | Quote provenance and freshness gates | Prevent stale/delayed quotes masquerading as live | Some signals `WATCH_ONLY` by design |
| 011 | Decimal arithmetic in money operations | Avoid binary float drift | `NUMERIC` and decimal types required |
| 012 | Point-in-time research history | Prevent revision overwrite and look-ahead | Persist `published_at`, `available_at`, revisions |
| 013 | Separate simulated vs real trade outcomes | Prevent hindsight AI self-grading | Journal, outcome evidence and fees required |
| 014 | Performance optimization as research objective | Risk-adjusted net returns matter | No claims of guaranteed outcomes |
| 015 | No broad enterprise security architecture | One private owner, local by default | Minimal secret hygiene and private cloud network remain |
| 016 | Direct OpenAI API access via environment key | User decision on 2026-10-30 replaces earlier ChatGPT sign-in discussion | `OPENAI_API_KEY` only in backend/worker runtime; no ChatGPT OAuth/session access or subscription dependency |
| 017 | Provider-neutral LlmProvider with native adapters | User wants future Google Gemini and Anthropic Claude support | OpenAI + fixture in v1; capability checks and SDK isolation; future adapters require the same behavioral tests |
| 018 | M²D owns context, tools and financial validation | Keep application behavior portable and auditable | Canonical records plus private provider continuation; start a new run when changing provider; no implicit provider fallback |
| 019 | Quick, Standard and Extensive analysis modes | Let the owner choose depth, latency and resource use; Standard is default | Mode policies remain provider-neutral, bounded by deployment/cost ceilings, with identical financial/data gates and no silent escalation |

ADRs 016–018 and `14_LLM_PROVIDERS.md` define the current AI boundary. Earlier conversation proposals to use ChatGPT sign-in or subscription sessions for M²D inference are superseded. App access remains local/private as specified by ADRs 001 and 015.

## M0 implementation decisions

- **020 — Single migration owner:** API container startup invokes the Drizzle migrator before the HTTP process. A session advisory lock serializes migrations. Worker/web wait for API readiness; neither migrates application tables. pg-boss manages its own schema from the worker.
- **021 — Operational-only fixture foundation:** M0 persists only heartbeat/demo-job records, returns explicit unavailable inference status, and displays future-feature placeholders. Financial contracts are decimal strings and confirmation/provenance schemas, without premature accounting or model implementations.
- **022 — Separate service health:** Database readiness does not depend on optional inference or worker liveness. Timestamped worker and demo-job status expose stalls/offline gaps without manufacturing missed activity. See `M0_FOUNDATION.md` for thresholds and versioned routes.

## M1 implementation decisions

- **023 — One serialized confirmation boundary:** A singleton revision row is locked before staging/confirming mutations. Previews expire after 15 minutes, retain normalized diffs and content hashes, and reject stale revisions. Successful confirmations are idempotent. Canonical hashing does not depend on JSON object key order.
- **024 — Immutable ledger, rebuildable projections:** Current accounts/instrument identities and NUMERIC position/cash projections are normalized. Full baseline snapshots are validated JSON with decimal strings, rather than separate baseline child tables; typed events follow the latest baseline. Database triggers protect baselines/events/imports/change logs. Original XLSX bytes are retained in PostgreSQL for transactional local backup simplicity (bounded to 2 MiB each).
- **025 — Conservative M1 chronology/accounting:** Reject inserts before the latest effective boundary. Use average-cost pseudo-lots with explicit COMPLETE_LEDGER / BASELINE_ESTIMATE / UNKNOWN quality; do not claim tax basis or aggregate-snapshot performance. Only explicit standard physically settled 100-share options and USD/CAD are supported. Unsupported settlements require reconciliation, not guessed events.
- **026 — Explicit offline portfolio input:** Structured forms and a canonical values-only Excel template share the same preview/confirm service. No natural-language parser or inference implementation is added before M2. Browser mutations use an allowlisted same-origin proxy. See `M1_PORTFOLIO.md` for supported contracts, limits and tests.

- **027 — Flexible Excel interpretation (user clarification, 2026-10-31):** The canonical template is optional. M1 infers headers across existing workbook tabs, then requires review of mappings, defaults, excluded rows and unresolved data before preview/confirmation. Original bytes and every reviewed interpretation are immutable. Cached formula results are treated as untrusted saved values, never executed. Missing values require explicit clarification; financial-state replacement gates are unchanged. This supersedes the canonical-only clause in the original input design without implementing M2 inference.

## ADR-028 — Simplify portfolio entry and apply new imports on confirmation

Per user direction on 2026-10-31, remove workbook timestamp entry, the template download link and structured single-change form from the portfolio UI. Incremental entry will use M2 chat. Omitted import effectiveAt selects a persisted confirmation-time policy; use the server transaction time for committed baseline/revision/history while preserving existing explicitly dated imports and deduplication. Keep operation errors in their own sections. Typed incremental APIs and the template endpoint remain internal compatibility facilities.

## ADR-029 — AI interprets workbooks in M1, without manual mapping

Per explicit user direction on 2026-10-31, move bounded workbook extraction through the provider-neutral LlmProvider/OpenAI Responses boundary into M1. Keep natural-language trades, chat, tool loops and analysis modes in M2. The model proposes only an evidence-grounded internal mapping; deterministic validation, visible source exclusions and human confirmation remain mandatory. Clarification uses plain text instead of mapping controls. Preserve raw input and model runs, deduplicate requests across restarts, cap calls/size/time/concurrency and expose unavailable/quota/refusal states without fallback. Offline fixture mode stays explicit and fully testable without keys.

## ADR-030 — Account holdings, optional basis and import Agent

Per user direction on 2026-10-31, support many broker/platform accounts with cash and stock/ETF or individually represented option legs. Asset class, symbol and quantity are required; unit cost and description are optional. Missing currency defaults to USD; explicitly specified recognized currencies replace the original USD/CAD restriction. Missing cost is null/UNKNOWN, never fabricated zero. Multi-leg positions use an optional group label; account/instrument netting remains the identity boundary. Preserve old baselines and compatibility with canonical workbook columns.

Expand the M1 workbook clarification UI into the responsive, closable Agent panel. This supersedes the general prohibition on an M1 chat surface only for import clarification/confirmation. General chat, trade-language updates and analysis modes remain M2. Remember safe layout mappings in PostgreSQL only after confirmation; scope reuse to matching layout and account evidence. Never remember financial cell values or row-specific corrections as reusable defaults. Persist original files and interpretation audits and retain explicit full-replacement confirmation for every import.

## ADR-031 — Shared portfolio Agent, explicit tab identity and optional holding dates

Per user direction, mount Agent in the root layout during M1. Portfolio state and its selected file remain mounted across Next.js navigation; all function pages expose the same Agent. This is portfolio assistance only, not early implementation of research/opportunity orchestration or M2 trade-language functionality. Draft recovery after browser refresh is not promised.

Require an explicit new-account/rename decision for unfamiliar account-bearing tabs. Rename preserves stable IDs and history; display-name changes and normalized tab aliases commit only with the full portfolio confirmation. Persist choices in the immutable mapping audit and aliases as a transactional projection. Never pick the first of multiple broker accounts with the same name. Explicit account-column layouts are keyed by their account fields, rather than by the worksheet name.

Optional holding transactionDate is an ISO calendar date stored in the DATE projection column and historical JSON snapshots. It is descriptive snapshot metadata, not a substitute for transaction-level accounting. Questions must identify source context and answer choices without repeated error blocks. Generate docs/ERD.md from Drizzle and check freshness in CI whenever schema changes.

## ADR-032 — One Agent, separate function contexts

Per user direction, restore each function's own conversation and unsent draft on navigation. Keep each context mounted in the shared layout, with an explicit Agent · Function header. Portfolio workflows and asynchronous results remain owned by Portfolio regardless of the active route. Context switches cannot apply, reject or cancel a preview. Close/reopen preserves contexts. Non-portfolio contexts are session notes/drafts only during M1, with explicit planned-capability labels and no model dispatch. This supersedes the single shared transcript in ADR-031 without implementing later milestone analysis features or browser-reload draft recovery.

## ADR-033 — Separate workbook facts from conversational help

Follow-up: preserve source-scoped factual replies instead of flattening short answers. Reapply recognized explicit row corrections, allow cash in positions ranges, and normalize unambiguous written dates. Detect unresolved answered fields and report interpretation failure with an explicit retry instead of cycling through questions. Financial confirmation and evidence gates remain unchanged.

Workbook parsing previously concatenated every user message as factual clarification, losing the question/answer context. Pass the latest message, pending question and conversation separately from accepted facts. Use a structured model intent/reply and a deterministic question/explicit-help guard. Explanation turns are audited and idempotent, but cannot remap staging, advance the pending question or create a preview. Assistant examples never become grounding evidence. Present one pending issue, not the raw validation backlog. Preserve explicit confirmation and scope this behavior to M1 workbook assistance. Existing import-run storage holds the audit; no schema migration is required.

## ADR-034 — Confirmed source-matched rules and current-year expiry policy

Per user direction, extend the existing immutable PostgreSQL format-memory profiles to version 2. Persist eligible source-token classification/currency corrections and source-pattern-scoped option terms, not fixed row numbers or financial snapshot values. Reapply only after matching headers, account identity and current source predicates; retain old versions and prefer the latest confirmed profile for a layout. Candidate rules never become reusable until portfolio confirmation succeeds. Quantities, costs, symbols and cash are always read from the new workbook. No schema migration is needed; the existing JSONB profile and immutable-history trigger hold the new version.

An omitted expiry year defaults to the current America/Vancouver calendar year when month/day are explicit. Show this assumption in the preview. Preserve explicit years, do not roll past dates into the next year, and reject invalid dates. The default is evaluated per parse, not saved as a reusable expiry value. Multiplier/deliverable assumptions remain evidence-bound or tied to matched, previously confirmed rules.

## ADR-035 — Persisted bounded chat runs and explicit preview authority

M2 persists per-function canonical conversations and scoped private Responses continuation. PostgreSQL owns run idempotence, tool replay, mode/default settings, progress and conservative cost reservations. Reuse the M1 shared inference lock to prevent concurrent workbook/chat work; recover abandoned runs only while holding it. Archive sessions rather than deleting audit history. Stream text provisionally and execute tool arguments only after a terminal validated response. Modes freeze work ceilings at run creation and cannot introduce unimplemented market or research tools.

The Agent allowlist contains read and preview tools only. Extend the existing deterministic confirmation transaction to reject previews whose owning chat run is unfinished or unsuccessful. No model-accessible commit route exists. Interruption closes dangling canonical tool calls, rejects pending previews and preserves uncertain usage reservations. Keep provider-specific encrypted reasoning payloads private and reject mismatched continuation scope.

Optional deployment cost limits fail closed without operator-maintained rate metadata. Paid M1 workbook parsing is disabled under these limits until its separate pipeline participates in monetary accounting; it must not bypass the shared budget. This is an explicit compatibility limitation, not a silent provider switch. See M2_CHAT.md for implementation and verification.

## ADR-036 — Versioned market evidence and indicative M3 valuation

Use a provider-neutral market package with fixed offline examples and one optional Twelve Data REST adapter. Keep real credentials only in backend environment. M3 reads cached data and refreshes only on explicit user request; monitoring schedules remain M6. Global PostgreSQL locks, durable request keys, cooldowns and startup recovery bound provider work. No automatic retry or cross-provider fallback occurs.

Store bounded, Zod-validated quote/bar/FX/options envelopes in one append-only market_observations table, alongside indexed identity/timestamps and original response evidence. This intentionally implements the design's conceptual quote/bar/FX/options entities as versioned feed envelopes rather than four sparse physical tables. It does not change relational portfolio positions/cash. Retain received_at and available_at independently of price as_of, preserve revised evidence, and expose only parsed data. Saved valuations include immutable per-position results, portfolio revision and observation references.

Use exact instrument identity and explicit FX. Missing marks or FX make total NAV unavailable, with a separately labeled known subtotal. Midpoint or last/regular-close marks remain indicative; M3 never produces execution signals. Preserve short-option liabilities and unknown/estimated basis. The real adapter supports explicit US equity exchanges and FX but no licensed options feed; missing Greeks/prices are first-class unavailable states. A finite, sourced 2026–2027 NYSE equity calendar returns UNKNOWN outside coverage. Do not infer future calendar rules or introduce research/risk/monitoring work ahead of its milestone.

## ADR-037 — Free end-of-day development data

Per user choice, add an optional Massive Basic adapter within M3. Preserve fixture and Twelve Data modes. The free adapter uses prior completed trading dates and individual option closes, not paid chain snapshots or live quotes. Validate US ticker identity and standard option contract terms before applying marks. Label daily period end separately from an unknown exact trade timestamp; preserve source decimal tokens and unadjusted values. No FX subscription or currency trading is introduced.

Workbook imports can legitimately omit exchange (`UNKNOWN`). Within the configured US/USD feed, resolve the exact symbol against provider reference data and retain the verified listing in quote metadata while preserving the original ledger key. Do not guess an exchange or relax a conflicting explicit exchange. Standard option terms must still match the reference contract exactly. Instrument-specific absence/invalidity should leave that source unpriced and let other holdings refresh under the same rate gate. Provider-wide failures still stop the batch. Show each completed valuation immediately instead of waiting for a potentially multi-minute batch.

Persist a per-provider HTTP dispatch gate in `market_provider_limits` so reference and pricing calls share the five-per-minute Basic allowance even across API restarts. Serialize refreshes, pace each dispatch by 13 seconds, reuse completed-day evidence, retain last-good values on failure and never silently upgrade endpoints or retry provider errors. Read-only Agent/navigation calls stay cached. A quote-kind request can now cover an individual option for this adapter; existing fixture chain requests retain their behavior. API contracts remain version 1 with additive provider/quote-kind values. Migrations 0009–0010 and the generated ERD accompany this extension. M4 remains unimplemented.

## ADR-038 — User-authorized IBKR hosted MCP market data

The user's explicit request permits one limited exception to ADR-002: IBKR's official hosted MCP endpoint behind the existing M3 market provider interface. The official MCP SDK handles transport and OAuth; all inference still goes through `packages/llm`. Authorization belongs to M²D, not to a desktop or ChatGPT plugin. Request only `mcp.read`, reject broader grants, pin the official issuer/endpoints, use PKCE plus one-time browser-bound state, and persist tokens only in a private API credential volume. There is no account synchronization, order/instruction tooling or provider access through arbitrary Agent tools.

Allow only contract search, price snapshots, historical bars, option parameters and option structure. Resolve exact instruments before normalization and retain original evidence plus point-in-time availability. A snapshot lacking a usable source timestamp remains unavailable; an untimestamped book cannot inherit a trade timestamp. Unknown/frozen status, numeric delay, bar adjustment and missing Greeks stay explicit. Standard option class/description checks are a constrained convention, not corporate-action deliverable verification. Limit option samples and per-refresh calls; retain durable pacing and idempotency. See `IBKR_MCP.md` for setup and limitations. Migration 0011 expands existing provider constraints; no financial tables change. M4 remains unimplemented.


## ADR-039 - Listing display metadata is separate from portfolio facts and price providers

**Decision:** Add an explicitly selected listing source (`none`, `fixture`, or `massive`) alongside the price provider. Use verified reference names and cached branding for holdings; preserve workbook descriptions and all financial state. Reuse append-only market observations with a new `listing` payload and retrieval/available timestamps. Metadata retrieval runs only on explicit refresh, with identity validation, idempotency, bounded batches and the same durable Massive HTTP allowance. Serve validated bounded images from local cache; never expose credentials, guess logo domains or substitute synthetic metadata after a real-provider failure. Missing images use a neutral icon. Options retain contract terms and display the underlying issuer/fund identity.

**Reason:** The user requested full listing names and company/fund logos, including while IBKR supplies prices. A display enrichment must neither rewrite confirmed ledger history nor imply live price quality. Massive's existing Basic reference endpoint supplies names and optional branding without a new service or LLM dependency. Seven-day reuse (five minutes after a logo failure) limits repeated lookups; absent branding is an explicit coverage limitation.

## ADR-040 — Saved market sources and visible-browser refresh

The user requested separate UI source selectors, per-holding market prices and an optional refresh interval. Persist price/listing overrides and a bounded interval in the singleton app_settings with optimistic revision checks (migration 0013); preserve analysis settings and financial state. Environment provider values remain initial defaults. All configured adapters are available without restarting; missing credentials disable selection. IBKR's existing allowlisted search_contracts tool supplies descriptive metadata without logos or an invented stock/ETF classification. Massive remains the full-name/logo option. No new external tools, broker-account access or LLM calls are added.

Capture one concrete provider per request and keep provider-scoped cache/evidence reads. The expectedProvider request guard prevents an old browser batch from dispatching against a newly selected source. Saved valuations use their captured provider, not a mutable current selection. Late responses must not appear under a new source's labels. Price freshness is computed at display time; recorded quantity, unit cost, transaction price and portfolio revision remain unchanged.

Manual is the default. An explicit saved interval enables bounded, sequential price batches only while Portfolio or Market is visible. Count down after completion, serialize within the browser, retain server gates, pause on source failures, and reset to Manual when switching price provider. Stop/navigation prevents subsequent dispatches; already running calls may finish. Metadata refresh is excluded from automatic batches. This user-requested browser convenience does not start M6 monitoring, scheduling services, alerts or automatic trades. Fixture/mock tests exercise all paths without keys or paid inference.

## ADR-041 — Immutable, bounded manual research before scheduled monitoring

M4 introduces a research package and immutable PostgreSQL source/chunk/fact/claim records. Each import commits its originals, extracted evidence and completion status atomically. Original bytes use base64 text within PostgreSQL under a 12-MiB source limit; this incurs storage overhead but avoids file/database orphan states and makes existing backups sufficient. The planned file-store abstraction can replace this representation later without changing source IDs or hashes.

The long-term architecture assigns ingestion to the worker. For this manual-only M4 implementation, bounded API background tasks follow the existing manual market/chat pattern and persist request IDs, fingerprints and statuses. Failures do not replace good research; startup marks interrupted requests for explicit retry instead of silently repeating external downloads. PDF parsing is isolated in a capped child process. The independent pg-boss worker continues its existing jobs. Moving manual imports into the process worker and adding scheduled retrieval are deferred; no M6 monitor is implied by this delivery.

Availability uses first observation (or later declared publication), so a current SEC XBRL download cannot rewrite a historical simulation. Financial rows retain reported accessions, periods and units without inventing comparable growth ratios. Claims are exact, topic-selected issuer quotations with an extractor version; Agent interpretation stays in canonical, budgeted chat history. The initial M4 delivery used PostgreSQL full-text search without embeddings. ADR-042 extends retrieval at the user’s request; document import still does not automatically trigger paid inference.

## ADR-042 — Shared company search with bounded, explicit semantic indexing

The user requested effective company research for both humans and Agent. Add one versioned search contract/service with full-text and pgvector cosine retrieval, reciprocal rank fusion, source diversity, company/source/publication/availability filters, latest eligible revisions, exact passage context and filtered financial facts. Keep legacy v1 APIs compatible. UI and Agent consume identical evidence; no paid reranking or model-generated facts are introduced.

Embeddings use the existing provider-neutral LlmProvider and selected backend provider/key. OpenAI uses text-embedding-3-small at 1536 dimensions; fixture vectors are explicitly synthetic and never a fallback. Indexing is an explicit resumable operation, capped at 256 missing passages, 32 inputs per request and one active job. Cache keys include provider/model/dimensions/adapter/preparation version. Persist byte/cost reservations before dispatch; keep uncertain reservations after failures. Agent query embeddings count against the selected model-attempt and cost budgets. Non-Agent search expenses also participate in the configured daily inference gate.

Use pgvector in PostgreSQL 17 without introducing another service or changing the database major version. The additive migration and Compose image preserve existing volumes. Exact distance computation occurs after eligibility filtering; this favors historical correctness and avoids ANN post-filter recall loss at the present personal-corpus size. Large-scale ANN/reranker tuning and broad real-filing relevance evaluation remain future work. An initial live synthetic-corpus evaluation is recorded in the company-search guide; fixture tests alone do not establish model relevance. Full details and limits: [company search](COMPANY_SEARCH.md).


## ADR-043 — Ground selected-company Agent questions before model-selected filters

Authorized live evaluation exposed two retrieval failures that fixture-only tests did not establish: the model inferred a midnight evidence cutoff and unrequested filing/source filters, hiding valid same-day uploads. Prompt guidance alone did not reliably prevent this. For a selected-company research question, the orchestrator now performs one initial shared search with the selected symbol, up to 500 characters of the actual question, a five-passage limit and the explicit UI availability cutoff, without invented source/form/publication filters. The full message remains saved. This read is recorded in canonical history before inference; model refinements and exact-fact/context tools remain available. An initial broad read provides context, not permission to disregard requested restrictions. Strict historical availability remains enforced by the selected UI cutoff.

Initial retrieval uses the same idempotent tool repository, cancellation/deadline and tool/model-attempt/cost gates as other Agent reads. Provider failures are surfaced rather than silently replaced with fixture data. The integration adds no financial mutations, crawler, automatic indexing or later-milestone signals. Live checks use isolated synthetic/public inputs, real configured adapters, explicit test ceilings and saved usage/results; CI remains offline. See [live results, the repeatable command and limitations](COMPANY_SEARCH.md#live-evaluation-and-agent-grounding).

## ADR-044 — Public source library with immutable manual imports

At the user’s request, extend M4 beyond SEC and uploads with company/IR, fund, OCC, macro and news source categories. Persist company-scoped public URL preferences and use a bounded backend HTTPS reader with public DNS pinning, redirect validation and no arbitrary credential forwarding. Reuse the original-document/chunk/revision pipeline and shared user/Agent search instead of introducing a crawler or separate research service.

Massive supplies a bounded set of publisher news summaries with original links using the existing backend key. Preserve the source JSON; do not scrape licensed full articles or elevate sentiment to facts. Public feeds are snapshots with conservative observation-based availability, not historical completeness. Publisher categories are not authentication and source pages are never executable instructions. The Agent treats exact OCC memo applicability separately from directory context and cannot alter contract/portfolio state.

Public source fixture/live selection is independent of SEC configuration. Network and inference costs remain distinct: imports/keyword search do not trigger embeddings or an LLM. Link removal retains imported history, old idempotency fingerprints remain compatible, and missing/blocked sources surface explicit errors. M6 scheduling/monitoring remains out of scope. Details and evidence: [public research sources](RESEARCH_SOURCES.md).

## ADR-045 — Analyst opinions remain attributed research

Add analyst source/upload classification to M4. Preserve originals and derive versioned labelled excerpts from stored chunks; absent or ambiguous values stay unknown. Flexible interpretation and comparison use the existing budgeted, cited Agent tools. No inferred target currency/horizon, market consensus or company facts are generated by the label extractor. Public bank directories are discovery aids; restricted reports require permitted uploads, with no new brokerage access. See [Analyst Research](ANALYST_RESEARCH.md).

## ADR-046 — Source-linked company charts

Research charts reuse cached M3 hourly bars and immutable M4 facts. An optional historical cutoff is added to the existing versioned bar-read contract; navigation stays read-only and provider refresh remains explicit. Financial series keep exact taxonomy/unit/provider and comparable durations separate, exclude cumulative periods, and withhold same-filing conflicts. No inferred cash flow, ratio, price causation or analyst consensus is introduced. See [Company charts](COMPANY_CHARTS.md).


## ADR-047 — Resolve chart listings through saved provider evidence

Research charts no longer default to NASDAQ or ask for an exchange. Versioned market refresh accepts listing-resolution evidence, stores originals and candidates, automatically selects a unique supported match and asks only for real alternatives. Bar requests bind to a verified candidate ID; IBKR contract IDs preserve same-exchange ambiguity. Cache, rate gates, idempotency and historical availability use the existing market repository. Migration 0018 is additive to the kind constraint. No LLM, financial mutation, account sync or provider fallback is introduced. See [Company charts](COMPANY_CHARTS.md#automatic-listing-resolution).
