# Paste this prompt into Codex after placing this design package in the repository

You are the lead engineer and architect implementing **M²D — Move · Motive · Decision**, a personal AI investment decision-support application. This repository contains the approved functional and technical specification. Work from `README.md`, `AGENTS.md`, and all files under `docs/`.

The product objective is to improve risk-adjusted, after-fee investment outcomes by continuously monitoring a locally recorded personal portfolio, investigating market moves and their drivers, identifying actionable equity/options opportunities, constructing transparent entry/exit/risk plans, and evaluating signal outcomes.

**Hard boundaries:** Standalone custom system (NOT OpenClaw). Single user. No tenant model, signup, RBAC, billing, brokerage connections, broker account sync, brokerage login or automatic order execution. Assets are recorded only by (1) natural-language incremental transactions with preview+confirm, and (2) uploaded Excel full replacement of all current accounts, positions and cash, with preview+confirm and immutable history. Public/licensed third-party market/filing/news data providers are allowed. Docker Compose local now, portable to a private cloud later.

**AI access:** Direct OpenAI API calls using `OPENAI_API_KEY` from backend/worker environment variables. No ChatGPT sign-in, OAuth, session credentials or subscription-backed inference access. Configure `LLM_PROVIDER` and `LLM_MODEL`; explicit `fixture` mode runs offline. Implement fixture and OpenAI adapters in M2. Reserve Gemini and Anthropic Claude for later adapters; do not implement them now. Follow `docs/14_LLM_PROVIDERS.md`.

**Architecture:** pnpm TypeScript strict monorepo, Next.js frontend, Fastify API, independent worker, PostgreSQL/Drizzle, pg-boss queue, deterministic financial packages, optional pgvector for research, custom bounded LLM tool loop in `packages/agent`, provider-neutral `LlmProvider` contracts/factory/adapters in `packages/llm`, and fixture mode. Native SDK types stay inside adapters; M²D owns tools, state and deterministic validation. Start with only `web`, `api`, `worker`, `postgres` containers. Use docker volumes for DB and research/raw uploads. Do not build microservices or large enterprise infrastructure or introduce an external orchestration framework.

**Your instructions now:**
User-selectable Quick, Standard (default) and Extensive analysis is part of M2 under `docs/15_ANALYSIS_MODES.md`. Preserve this requirement in the plan; do not implement it prematurely in M0.

1. Read and cross-check every document and report any internal inconsistencies before editing code. Use `AGENTS.md` as the non-negotiable contract.
2. Provide a concise milestone-by-milestone architecture plan with package interfaces and a list of M0 files to create.
3. **Implement only M0 (Runnable Foundation)** from `docs/11_MILESTONES.md`. Do not prematurely implement the full product.
4. Include: functioning `compose.yaml`, multi-stage Dockerfiles, pnpm monorepo, Next.js UI with M²D branding and navigation placeholders, Fastify `/health/live` and `/health/ready`, separate worker process with a verified demo scheduled job/heartbeat persisted to Postgres, Drizzle migrations and `pg-boss` initialization, fixture provider configurations, tests, `.env.example` with `LLM_PROVIDER=fixture`, `LLM_MODEL` and a blank server-only `OPENAI_API_KEY`, README setup instructions, and basic CI workflow. M0 must start without API keys or inference calls; functional OpenAI integration remains in M2.
5. Run the real checks you can: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `docker compose config`, and `docker compose up --build` with endpoint/UI verification. Report unsupported/missing runtime dependencies transparently.
6. Finish with an implementation report, commands to run locally, screenshots if possible, known limitations, and a proposed scope for M1. **Stop after M0**, awaiting next instruction.

Financial correctness safeguards must exist as documented rules and type contracts from day one; numerical calculations and editing features are built in later milestones with golden fixture tests.
