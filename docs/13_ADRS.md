# 13 — Architecture Decision Records

| ADR | Decision | Rationale | Consequence |
|---|---|---|---|
| 001 | Single-user independent system | Personal investment use, minimal friction | No user/tenant/auth modules in initial design |
| 002 | No broker integration or orders | User enters positions manually or by Excel | Actual fills are self-reported; never assume account state synced |
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
