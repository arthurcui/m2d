# Company evidence search

M4 has one retrieval service shared by Research and Agent. Search only reads imported evidence; it does not browse the web, fetch live prices, generate a trading signal or change the portfolio.

## Use

1. Choose a saved company name or ticker on Research. Retrieve reports or upload relevant PDF/text documents first.
2. Ask a natural-language question in **Search stored evidence**. Keyword search is immediately available, with quoted phrases, `OR` and minus exclusions.
3. Choose **Build search index** to enable meaning-based retrieval. This explicitly sends that company's stored passages to the configured inference provider. OpenAI API usage is separate from SEC downloads. New uploads do not automatically trigger paid indexing; **Update search index** adds missing passages and reuses cached work.
4. Search again. Automatic mode uses hybrid search when an index exists and clearly labels keyword-only or partial coverage. Explicit Hybrid/Semantic requests without an index return an actionable error; provider failures never silently substitute fixtures or keyword results.
5. Narrow by document type, source, publication range or historical availability cutoff. By default each source uses its latest revision **available at that cutoff**. Including superseded revisions is explicit. Undated documents do not match publication-date filters.
6. Open a cited passage to inspect its context, or choose **Ask Agent about results** and send the prepared question. Query/filter drafts and results survive function navigation while the app stays open. Search returns no generated answer until you explicitly ask Agent.

Result cards distinguish word and meaning matches and display publication/availability timestamps, source, document revision and a stable passage link. Ranking is relevance, not a probability that a claim is true. Conflicting sources remain evidence to inspect; no-result messages do not imply the absence of a risk.

## Retrieval and exact financial data

- PostgreSQL English full-text search uses the existing GIN index. Ordinary questions broaden lexical recall across terms; explicit phrase/Boolean syntax is preserved. Exact phrase and full-query matches rank before broader term matches.
- pgvector computes exact cosine similarity **after company, source, publication and availability filtering**. It excludes cosine similarity below 0.25. This threshold is a retrieval heuristic, not calibrated confidence. Exact filtered scans suit the current personal research corpus and avoid approximate-index filtering losses; large-corpus ANN tuning is deferred until measurements justify it.
- Each retriever returns at most 96 candidates. Reciprocal rank fusion (`rrf-v1`, constant 60) combines ranks without comparing unrelated score scales. Identical passage text is deduplicated; the first three passages from each source precede overflow from that source. Responses contain at most 20 passages (UI default 12).
- Stable original chunks and PDF page anchors are unchanged. A separate read tool returns a matched passage and its immediate neighbors. Search does not rewrite original evidence or renumber citations.
- Exact financial questions can use `research_query_facts_v2`: filter by taxonomy/metric substring, native unit and period end. Results preserve decimal strings, accessions, units and source IDs, and explicitly report truncation. Numerical calculations and restatement reconciliation are not delegated to vector similarity.
- Saved-company lookup supports ticker, issuer name and CIK. Multiple matches require selection; no company is inferred from an approximate name.

## Models, cache and limits

All embedding requests use the provider-neutral `LlmProvider.embed` port. The selected `LLM_PROVIDER` determines the adapter; there is no separate credential or automatic provider fallback.

| Configuration                            | Behavior                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `LLM_PROVIDER=openai`                    | Existing backend `OPENAI_API_KEY`; `text-embedding-3-small`, 1536 dimensions                                    |
| `LLM_PROVIDER=fixture`                   | Explicit synthetic test vectors, no key/network/cost; not a real local semantic model                           |
| `RESEARCH_EMBEDDING_DAILY_BYTES=1000000` | Daily UTC input-byte reservation ceiling across indexing and query calls; configurable from 8,000 to 10,000,000 |

Input bytes conservatively bound input tokens. Each provider request is limited to 32 strings, 8,000 UTF-8 bytes per string, and 20 seconds, with no automatic retry. An index action processes at most 256 missing passages; continue indexing if coverage is incomplete. One index job runs at a time. Completed passage vectors survive failures/restarts; interrupted jobs require an explicit continuation.

The cache key includes provider, model, dimensions, adapter/passage preparation version, purpose and exact normalized input. Document vectors and query vectors cannot be mixed across profiles. Query text is represented by a hash in the cache; original source passages remain in their existing evidence records. Changing profiles retains old vectors but requires rebuilding the selected index. No expiry or vector garbage collection is implemented yet.

Usage, input-byte reservations, estimated costs and uncertain requests are durable. The OpenAI input estimate uses USD 0.02 per million tokens, price version `openai-embedding-small-2026-10-31`, verified against the [model documentation](https://developers.openai.com/api/docs/models/text-embedding-3-small). These are estimates, not provider billing statements. Failed requests retain conservative reservations when usage is unknown. The daily-byte cap remains in force when USD limits are unset.

An uncached Agent query embedding consumes a model attempt, respects cancellation/deadline, and reserves/records cost in that Agent run. Cached queries consume no new model attempt or inference cost. Non-Agent indexing/search costs and Agent costs share the existing configured `LLM_DAILY_BUDGET_USD` gate without double counting. Agent queries also retain `LLM_MAX_RUN_COST_USD` and the chosen Quick/Standard/Extensive limits. Building an index is an explicit bounded maintenance action, not an escalation of an Agent run.

## Contracts and database

| Contract                                                                             | Purpose                                                                                              |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `POST /api/v1/research/search`, body `version: 2`                                    | Shared ranked search: symbol, query, optional mode/forms/source/publication dates/revisions/limit/at |
| `GET /api/v1/research/search/status?symbol=…&at=…`                                   | Provider/model, eligible coverage, daily usage and latest index-job status                           |
| `POST /api/v1/research/search/index`, body `version: 1`, symbol, UUID idempotencyKey | Explicit bounded index update; returns a durable job ID                                              |
| `GET /api/v1/research/search/jobs/:id`                                               | Index progress, completion/failure/interruption                                                      |
| `GET /api/v1/research/companies?query=…&at=…`                                        | Saved-company lookup                                                                                 |
| `research_search_evidence_v2`                                                        | Same search contract/results for Agent                                                               |
| `research_read_passage_v1`                                                           | Neighboring source context with enforced availability cutoff                                         |
| `research_query_facts_v2`                                                            | Filtered exact financial values, at most 100 rows                                                    |
| `research_find_company_v1`                                                           | Saved-company identity lookup                                                                        |

The legacy GET search and v1 tools remain compatible. Migration 0015 enables pgvector and adds immutable vector cache/link tables, a usage ledger and durable indexing jobs. Compose/CI use `pgvector/pgvector:0.8.7-pg17-bookworm`, retaining PostgreSQL **major version 17** and existing volumes. Native PostgreSQL setups must install pgvector before running the migration. Never delete volumes to enable the extension. See [the generated ERD](ERD.md) and [pgvector installation documentation](https://github.com/pgvector/pgvector#installation).

## Verification and remaining limits

Offline tests cover rank fusion/diversity, preserved decimals, adapter response validation, no automatic retries, cache reuse, index idempotence, source/company/date filters, historical revision isolation, structured facts, input/cost/attempt limits, uncertain requests, restart recovery, shared API/Agent results and desktop/mobile navigation/citations. Synthetic vectors test these mechanics; they **do not demonstrate OpenAI semantic relevance**. Live embedding relevance must be evaluated on representative company questions before treating retrieval quality as established.

No paid reranker, query-rewriting LLM, local embedding download, external vector database, automatic research crawler, M5 signal engine or M6 monitoring was added. English lexical search and text-extractable PDFs retain the M4 limitations. Search quality still depends on importing useful, sufficiently current sources; coverage reports the imported corpus, not completeness of public information.

Verified on the delivered implementation: 170 offline unit tests, 44 database/API integration tests and 31 Playwright browser tests. Strict typecheck, lint, formatting, generated ERD checks, Compose validation and Docker builds/startup passed. No live OpenAI embedding request was made during verification.
