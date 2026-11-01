# M²D database ERD

Generated from the implemented Drizzle schema. Run `pnpm docs:erd` after schema changes; `pnpm docs:erd:check` fails when this document is stale.

This is the current M4 application schema. PostgreSQL also contains pg-boss-managed queue tables, which are maintained by pg-boss and omitted here. Historical baselines and interpretation results contain typed JSON snapshots; positions and cash below are the rebuildable current projections. Stable account IDs preserve history across display-name changes. Confirmed sheet aliases point back to the same account. Holding transaction dates are optional date-only metadata, not a reconstructed transaction ledger.

The diagram shows declared database foreign keys. Logical references without a database foreign key (including revision baseline IDs, mapping preview IDs and JSON identifiers) are deliberately not drawn. Nullable attributes are marked in quotes.

```mermaid
erDiagram
    accounts {
        text account_key PK
        text display_name
        text institution
        text account_type
        text base_currency
        boolean active
        text notes
    }
    agent_runs {
        uuid id PK
        uuid session_id FK
        uuid request_key
        text fingerprint
        uuid parent_run_id "nullable"
        text provider
        text model
        text analysis_mode
        text policy_version
        text prompt_version
        text adapter_version
        integer schema_version
        jsonb effective_limits
        integer portfolio_revision
        text status
        text completeness
        jsonb limit_reasons
        jsonb events
        jsonb continuation "nullable"
        jsonb history
        uuid preview_id FK "nullable"
        jsonb usage "nullable"
        numeric_30__12_ reserved_cost
        numeric_30__12_ estimated_cost "nullable"
        text price_version "nullable"
        boolean cancel_requested
        timestamp_with_time_zone started_at
        timestamp_with_time_zone finished_at "nullable"
    }
    agent_sessions {
        uuid id PK
        text context
        jsonb history
        jsonb continuation "nullable"
        text draft
        integer revision
        timestamp_with_time_zone created_at
        timestamp_with_time_zone updated_at
    }
    agent_tool_calls {
        uuid run_id FK
        text call_id
        text fingerprint
        jsonb output
        timestamp_with_time_zone created_at
    }
    app_settings {
        integer id PK
        integer revision
        text default_analysis_mode "nullable"
        text market_provider "nullable"
        text listing_provider "nullable"
        integer price_refresh_seconds
    }
    cash_projection {
        text account_key FK
        text currency
        numeric_30__12_ balance
    }
    company_facts {
        uuid id PK
        uuid document_id FK
        text metric
        text unit
        date period_start "nullable"
        date period_end
        numeric value
        text accession
        date filed
    }
    demo_job_runs {
        uuid job_id PK
        text queue
        integer version
        timestamp_with_time_zone completed_at
    }
    document_chunks {
        uuid document_id FK
        integer chunk_index
        integer page "nullable"
        text text
    }
    instruments {
        text id PK
        jsonb definition
        text asset_type
        text symbol
        text exchange
        text currency
        numeric_30__12_ multiplier
    }
    market_observations {
        uuid id PK
        text provider
        text kind
        text subject
        text content_hash
        timestamp_with_time_zone as_of
        timestamp_with_time_zone received_at
        timestamp_with_time_zone available_at
        jsonb payload
        jsonb raw
    }
    market_provider_limits {
        text provider PK
        timestamp_with_time_zone next_allowed_at
    }
    market_refreshes {
        text request_key PK
        text fingerprint
        text provider
        text subject
        timestamp_with_time_zone started_at
        text status
        text error_code "nullable"
        uuid observation_id FK "nullable"
    }
    portfolio_account_aliases {
        text sheet_name PK
        text account_key FK
        timestamp_with_time_zone updated_at
        uuid source_import_id FK
    }
    portfolio_baselines {
        uuid id PK
        integer revision
        timestamp_with_time_zone effective_at
        timestamp_with_time_zone available_at
        uuid preview_id FK
        jsonb snapshot
        uuid import_id FK "nullable"
        uuid restores_baseline_id "nullable"
    }
    portfolio_change_log {
        uuid id PK
        integer revision
        text kind
        uuid record_id
        uuid preview_id FK
        timestamp_with_time_zone effective_at
        timestamp_with_time_zone available_at
        jsonb changes
        text note
    }
    portfolio_events {
        uuid id PK
        integer revision
        uuid baseline_id FK "nullable"
        timestamp_with_time_zone effective_at
        timestamp_with_time_zone available_at
        uuid preview_id FK
        jsonb operation
        jsonb realized
    }
    portfolio_import_mappings {
        uuid id PK
        uuid import_id FK
        timestamp_with_time_zone created_at
        jsonb config
        jsonb errors
        jsonb sources
        jsonb warnings
        jsonb normalized "nullable"
        uuid preview_id "nullable"
        jsonb memory "nullable"
    }
    portfolio_import_memories {
        uuid id PK
        text signature
        timestamp_with_time_zone created_at
        uuid source_import_id FK
        jsonb profile
    }
    portfolio_import_runs {
        uuid id PK
        uuid import_id FK
        uuid request_key
        text fingerprint
        timestamp_with_time_zone created_at
        timestamp_with_time_zone finished_at "nullable"
        text provider
        text model
        text status
        jsonb request
        jsonb response "nullable"
        text error_code "nullable"
        text error_message "nullable"
    }
    portfolio_imports {
        uuid id PK
        text hash
        text original_base64
        integer template_version
        boolean effective_on_confirmation
        timestamp_with_time_zone effective_at
        timestamp_with_time_zone created_at
        jsonb errors
        jsonb normalized "nullable"
    }
    portfolio_previews {
        uuid id PK
        text idempotency_key
        text hash
        integer expected_revision
        text kind
        text status
        timestamp_with_time_zone created_at
        timestamp_with_time_zone expires_at
        timestamp_with_time_zone effective_at
        uuid import_id FK "nullable"
        uuid restores_baseline_id "nullable"
        jsonb operation "nullable"
        jsonb proposed
        jsonb changes
        jsonb warnings
        jsonb realized
        integer confirmed_revision "nullable"
    }
    portfolio_revision {
        integer id PK
        integer revision
        timestamp_with_time_zone effective_at "nullable"
        uuid baseline_id "nullable"
    }
    position_projection {
        text account_key FK
        text instrument_id FK
        numeric_30__12_ quantity
        numeric_30__12_ average_cost "nullable"
        text description "nullable"
        text option_group "nullable"
        date transaction_date "nullable"
        text quality
        text notes
    }
    research_chunk_embeddings {
        uuid document_id
        integer chunk_index
        text profile
        text embedding_id FK
    }
    research_companies {
        uuid id PK
        text symbol
        text name
        text cik "nullable"
        timestamp_with_time_zone created_at
    }
    research_embedding_usage {
        uuid id PK
        text profile
        text purpose
        uuid agent_run_id FK "nullable"
        integer input_bytes
        integer input_tokens "nullable"
        numeric cost
        text price_version
        text status
        timestamp_with_time_zone created_at
    }
    research_embeddings {
        text id PK
        text profile
        text purpose
        vector_1536_ embedding
        timestamp_with_time_zone created_at
    }
    research_findings {
        uuid id PK
        uuid document_id FK
        integer chunk_index
        text claim
        text category
        text extractor_version
    }
    research_imports {
        uuid id PK
        text symbol
        text provider
        text fingerprint
        text status
        timestamp_with_time_zone started_at
        timestamp_with_time_zone finished_at "nullable"
        jsonb document_ids
        text error "nullable"
    }
    research_search_jobs {
        uuid id PK
        text symbol
        text profile
        text status
        integer processed
        text error "nullable"
        timestamp_with_time_zone started_at
        timestamp_with_time_zone finished_at "nullable"
    }
    research_source_links {
        uuid id PK
        text symbol
        text kind
        text name
        text url
        timestamp_with_time_zone created_at
    }
    source_documents {
        uuid id PK
        uuid company_id FK
        text provider
        text upstream_key
        text title
        text form
        text url "nullable"
        timestamp_with_time_zone published_at "nullable"
        timestamp_with_time_zone observed_at
        timestamp_with_time_zone available_at
        text hash
        integer revision
        text mime
        text raw_base64
    }
    valuation_snapshots {
        uuid id PK
        text request_key
        integer portfolio_revision
        timestamp_with_time_zone computed_at
        text provider
        text base_currency
        jsonb valuation
        jsonb observation_ids
    }
    worker_heartbeats {
        text id PK
        uuid instance_id
        timestamp_with_time_zone started_at
        timestamp_with_time_zone last_seen_at
    }
    agent_sessions ||--o{ agent_runs : "session_id"
    portfolio_previews |o--o{ agent_runs : "preview_id"
    agent_runs ||--o{ agent_tool_calls : "run_id"
    accounts ||--o{ cash_projection : "account_key"
    source_documents ||--o{ company_facts : "document_id"
    source_documents ||--o{ document_chunks : "document_id"
    market_observations |o--o{ market_refreshes : "observation_id"
    accounts ||--o{ portfolio_account_aliases : "account_key"
    portfolio_imports ||--o{ portfolio_account_aliases : "source_import_id"
    portfolio_previews ||--o{ portfolio_baselines : "preview_id"
    portfolio_imports |o--o{ portfolio_baselines : "import_id"
    portfolio_previews ||--o{ portfolio_change_log : "preview_id"
    portfolio_baselines |o--o{ portfolio_events : "baseline_id"
    portfolio_previews ||--o{ portfolio_events : "preview_id"
    portfolio_imports ||--o{ portfolio_import_mappings : "import_id"
    portfolio_imports ||--o{ portfolio_import_memories : "source_import_id"
    portfolio_imports ||--o{ portfolio_import_runs : "import_id"
    portfolio_imports |o--o{ portfolio_previews : "import_id"
    accounts ||--o{ position_projection : "account_key"
    instruments ||--o{ position_projection : "instrument_id"
    research_embeddings ||--o{ research_chunk_embeddings : "embedding_id"
    document_chunks ||--o{ research_chunk_embeddings : "document_id, chunk_index"
    agent_runs |o--o{ research_embedding_usage : "agent_run_id"
    source_documents ||--o{ research_findings : "document_id"
    research_companies ||--o{ source_documents : "company_id"
```
