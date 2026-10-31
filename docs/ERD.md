# M²D database ERD

Generated from the implemented Drizzle schema. Run `pnpm docs:erd` after schema changes; `pnpm docs:erd:check` fails when this document is stale.

This is the current M1 application schema. PostgreSQL also contains pg-boss-managed queue tables, which are maintained by pg-boss and omitted here. Historical baselines and interpretation results contain typed JSON snapshots; positions and cash below are the rebuildable current projections. Stable account IDs preserve history across display-name changes. Confirmed sheet aliases point back to the same account. Holding transaction dates are optional date-only metadata, not a reconstructed transaction ledger.

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
    cash_projection {
        text account_key FK
        text currency
        numeric_30__12_ balance
    }
    demo_job_runs {
        uuid job_id PK
        text queue
        integer version
        timestamp_with_time_zone completed_at
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
    worker_heartbeats {
        text id PK
        uuid instance_id
        timestamp_with_time_zone started_at
        timestamp_with_time_zone last_seen_at
    }
    accounts ||--o{ cash_projection : "account_key"
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
```
