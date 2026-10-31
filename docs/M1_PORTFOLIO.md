# M1 — Authoritative local portfolio

## Confirmed interpretation rules (profile v2)

The existing PostgreSQL `portfolio_import_memories` table stores append-only profile versions with their source import and confirmation timestamp. Creating or rejecting a preview does not promote its candidate rules. Confirmation saves rules transactionally with the portfolio; replaying confirmation cannot save duplicates. The newest confirmed profile for a layout takes precedence, and an incompatible newer profile cannot silently fall back to an older version of that same layout.

Profiles contain header/account guards, column mappings, safe account metadata, and source-value predicates. Classification/currency aliases follow the matching source token rather than a fixed row number. Option multiplier/deliverable rules require matching asset-type, symbol and description values. Changed labels, headers or unmatched contracts require validation/interpretation again. Compatible prior rules remain available even when their token is absent from one upload. A later confirmed correction appends a new version while preserving the old audit record.

Every new workbook supplies its own symbols, quantities, costs and cash balances. Neither financial row corrections nor missing-cash answers become reusable defaults. No expiry dates are remembered as rule outputs. Historical format-v1 profiles remain readable when they satisfy the current safety constraints. Broader legacy contract defaults require a fresh interpretation rather than silently applying to new contracts. There is no rule-editing UI yet; corrections made through import preview/confirmation update eligible rules. The existing ERD is unchanged because the versioned profile uses the existing JSONB column.

For an option description such as `12.50C 10-30`, or an expiry cell containing `10-30`, an omitted year now means the current **America/Vancouver** year. Explicit full dates take precedence. Dates in the past are not automatically rolled into next year; impossible dates still fail validation. The preview identifies every defaulted expiry date and year before confirmation. This supersedes the previous policy of asking for every missing expiry year.

## Conversational workbook clarification

Account-tab identity and display names come from application account decisions, before validating model-proposed metadata. Model-invented `Active` defaults are ignored when there is no explicit source column; presence in the snapshot defaults the account to active. `Active` never identifies a holding. Legacy internal-field questions return a recoverable interpretation error, not another request for financial facts. “Which row?” replies quote actual worksheet cells when an exact tab and row are known and explicitly decline to guess otherwise. Retry preserves accepted facts and account choices without replaying a stale explanation request. Account identification messages name the next tab and the remaining count. Missing-expiry-year questions are suppressed for recognized shorthand even when phrased with an unquoted tab name and parenthesized row number.

Agent composers send with Enter; Shift+Enter inserts a new line. Empty drafts, held-key repeats and IME composition do not send. The button remains available for touch and keyboard users; explicit retry actions remain separate from sending an empty draft.

Interpretation remains LLM-led for unfamiliar layouts. Reconciliation uses unambiguous source headers before model-added descriptions or classifications. Standard labels (`Stocks`, `STK`, `OPT`), currency-labelled cash rows and signed quantities are handled deterministically. Cash already present in a covered source row is not also imported from the model's missing-cash collection. Option shorthand such as `12.50C 10-30` establishes strike/right and month/day, but not an expiry year or adjusted-contract terms. An omitted expiry year defaults to the current America/Vancouver calendar year, with a preview warning; multiplier and deliverable still require source evidence or matching confirmed rules. Equivalent decimal representations are compared without floating-point arithmetic. Users are never expected to supply JSON or column mappings.

Factual replies retain their tab, row and field as structured JSON lines in accepted clarification; Agent question text and examples are never copied into evidence. Explicit all-account replies remain global. Recognized row answers for asset class, currency and dates are reapplied to later model mappings, preventing a corrected cash row from reverting to a security. A CASH row can be read inside a positions table without requiring a ticker. Missing USD defaults do not require fabricated model citations. Explicit ISO or month-name dates with a year are normalized deterministically; ambiguous numeric dates and invalid calendar dates remain unresolved. Option multipliers, deliverables and strike/premium distinctions still require evidence.

When a known answered field is still rejected, the API returns `ai.status=needs_review` with an explanation. **Retry interpretation** preserves accepted facts and makes an explicit new attempt; there are no automatic retries or repeated demands for the same answer.

Agent asks one unresolved question at a time. You can answer it, ask a follow-up such as "what is AccountType for?", or select **Explain this question**. An explanation keeps the same question pending; it never stages a new mapping or creates a portfolio preview. Account-type and option-term questions include plain-language descriptions and clearly illustrative examples. Raw row-validation backlogs remain in staging, rather than being pasted into chat.

The parse request accepts optional `dialogue: {message, question, explain?, history?}` separately from `clarification` (previously supplied facts). History entries contain `role: user|assistant` and `text`. The model sees the latest question and conversation but may ground values only in the workbook, supplied facts, existing account fields, permitted classifications, or a latest factual answer. An explanation response returns `ai.intent=explain`, `ai.reply`, the unchanged pending question, and unchanged `acceptedClarification`. Explicit question wording and the Explain button independently block mapping/preview creation even if the model returns a valid mapping. Model-detected implicit help requests use the same path. Answers can resume parsing; the confirmation gate remains mandatory.

Dialogue is bounded to 100 messages, 4,000 characters per message and the existing total input limit; previous facts remain limited to 4,000 characters. Limits fail explicitly instead of dropping context. Dialogue is included in the existing persisted run audit and idempotency fingerprint. No new database tables or ERD changes are needed. Session navigation behavior remains unchanged; this is workbook assistance, not M2 general-purpose chat.

M1 adds a self-reported portfolio ledger and AI workbook interpretation/clarification. General chat, incremental natural-language changes and analysis modes remain M2. Quotes, FX valuation and later analysis functions are not implemented; broker access and trade execution remain excluded.

## Run and use

```powershell
# Preserve an existing .env and database volume.
if (!(Test-Path .env)) { Copy-Item .env.example .env }
docker compose up --build --detach --wait --wait-timeout 180
```

Open `http://127.0.0.1:3000/portfolio` and upload your existing Excel workbook. Individual changes will use chat in M2; the structured single-change form is no longer shown. Typed incremental APIs and their confirmation gates remain available for M2 orchestration. Display times are labeled America/Vancouver.

For Excel, upload your existing multi-tab workbook, select **Preview workbook**. Recognized canonical templates go directly to a diff; other layouts are automatically interpreted by the configured provider. Review accounts, positions, cash and excluded source rows in the replacement preview. If information is missing, answer the plain-language clarification questions and parse again; there are no column-mapping controls. No template download is shown in the product. Review all additions, removals, zero balances, deactivated accounts, and warnings. Tick the full-replacement acknowledgment and confirm. Uploading alone never changes holdings. New UI imports take effect at server confirmation time; no timestamp input is required. Upload, interpretation, confirmation and history errors are displayed within their respective operation sections. Re-uploading identical bytes identifies the same import; a confirmed import cannot execute twice. Use **Preview restore as a new baseline effective now** from the change log when intentionally restoring prior state.

The generated seven-account example is fictional and is never seeded automatically:

```powershell
pnpm fixture:portfolio
# Output: data/exports/m1-seven-accounts.xlsx (ignored by Git)
```

Use it only in a disposable workspace. The fixture contains overlapping AAPL positions and USD/CAD account balances. Golden accounting tests separately cover signed option obligations and settlements.

## Accounting and persistence

- `packages/portfolio`: strict Zod contracts, pure deterministic operations, replacement/diff, and decimal.js arithmetic. Inputs are decimal strings; intermediate precision is 60 digits, persisted values use 12 fractional places with half-even rounding, up to 18 integer digits.
- `packages/ingestion`: maintained read/write-excel-file packages, bounded ZIP inspection with fflate, original SHA-256, inferred header mappings, source-row validation, template and fixture generation. Numeric Excel cells are read as decimal strings, not JavaScript floating-point values. Store long/precise amounts as Excel text to avoid Excel's own precision loss.
- `packages/db`: normalized account/instrument identities and numeric current positions/cash; immutable JSON snapshots for baselines, typed immutable events, original upload bytes, staging errors, persisted previews, and change log. Financial values in JSON are decimal strings. JSON snapshots are intentional for a small local workspace instead of duplicating the same baseline into additional child tables; current financial amounts have PostgreSQL NUMERIC constraints. Every snapshot is Zod-validated before persistence and replay.
- Database triggers forbid UPDATE/DELETE of baseline, event, original import, and change-log rows. Corrections append a new event (optionally linked by `correctionOf`); restores append a new baseline. Projection rows are derived and may be replaced transactionally.
- One locked revision row serializes confirmation. A 15-minute preview binds normalized input, content hash, expected revision, effective time, warnings, diff, and proposed state. Confirmation checks version, explicit consent, revision, expiry and idempotence, then atomically appends the event/baseline, rewrites projections and appends audit history. Concurrent stale proposals conflict; a repeated successful confirmation returns its original revision. Canonical hashes survive PostgreSQL JSON key ordering.
- Projection is the latest baseline plus subsequent ordered events. `replay()` independently reconstructs current state. `effectiveAt` is user-reported chronology; `availableAt` is when the workspace actually recorded evidence. History before a replacement remains inspectable.
- Average-cost accounting includes opening fees in long basis and deducts fees from short proceeds. Closing fees reduce recorded close P&L. Short options have negative quantity and mark-to-market liability; opening premium is cash, never immediate realized profit.
- Imported basis is `BASELINE_ESTIMATE`; explicit position corrections are `UNKNOWN`; a new position built entirely from recorded events is `COMPLETE_LEDGER`. These labels never establish tax basis or pre-baseline performance. Settlement propagates the weaker basis quality.
- Standard option exercise/assignment closes contracts and changes shares/cash atomically. Premium enters share basis/proceeds; actual cash uses strike × multiplier. Expiration requires verified non-exercise after the expiry date, never an inferred market outcome.

## Canonical workbook v1

Use precisely the headers in `docs/04_PORTFOLIO_INPUTS.md` and exactly Accounts, Positions, Cash sheets. Metadata (`templateVersion=1`, full replacement scope, optional explicit effective time) is supplied through the API, not inferred from the file. Header order/case is strict.

- Account types: CASH, MARGIN, RRSP, TFSA, OTHER; use OTHER and notes for other account labels. Active is TRUE/FALSE (text or boolean).
- Currencies: USD/CAD. Base-currency cash is mandatory for every account, even when zero. Other currencies are rejected, never converted.
- Assets: STOCK, ETF, OPTION. Symbols/venues use uppercase identifiers. Stocks/ETFs require Multiplier `1` and empty option fields. Options require CALL/PUT, ISO expiration, positive strike, Multiplier `100`, explicit Underlying and Deliverable `STANDARD`. The Exchange field is the underlying listing venue, and all contract fields participate in identity.
- Quantity is signed; options require whole contracts. AverageCost is nonnegative per quote unit, not total contract cost. Zero holdings may be retained for audit continuity. Negative cash is allowed and warned; this is not a buying-power calculation.
- Limits: 2 MiB compressed, 16 MiB total expanded, 8 MiB per ZIP entry, 200 ZIP entries, up to 30 tabs, 5,000 rows / 100 columns per tab, 10,000 total rows / 100,000 cells (canonical direct parsing remains limited to 2,200 data rows), 100 retained accounts, 2,000 retained position identities, 200 account/currency rows. Zeroed historical identities count toward these small-workspace limits. Sparse oversized coordinates, macros, external links, unevaluated formulas, malformed data, duplicates, and unknown accounts are rejected.
- Unlisted positions/currencies become zero and unlisted accounts inactive only at confirmation. Existing history and original files remain intact. Inactive accounts cannot hold nonzero positions/cash. An empty Accounts sheet is rejected; explicitly list inactive zeroed accounts to close the whole workspace.

## HTTP v1

All routes below have `/api/v1` prefix. JSON success responses use `{data, meta}` with version, source, response timestamp and quality. Overview includes the confirmed revision and effective time. Errors have typed codes and validation details; database internals are not exposed.

| Method | Route                                                   | Purpose                                                                             |
| ------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| GET    | `/accounts`                                             | Recorded accounts                                                                   |
| GET    | `/portfolio/overview`                                   | Revision, effective time, baseline ID, accounts/positions/cash, warnings            |
| GET    | `/portfolio/positions`, `/portfolio/cash`               | Optional `accountKey` filter                                                        |
| GET    | `/portfolio/history`, `/portfolio/accounts/:id/history` | Immutable confirmed changes                                                         |
| GET    | `/portfolio/template`                                   | Canonical blank XLSX                                                                |
| POST   | `/portfolio/changes/preview`                            | `{version:1, expectedRevision, idempotencyKey, operation}`                          |
| GET    | `/portfolio/changes/:id/preview`                        | Persisted proposal                                                                  |
| POST   | `/portfolio/changes/:id/confirm`                        | `{version:1, expectedRevision, confirmed:true, fullReplacementAcknowledged?}`       |
| POST   | `/portfolio/changes/:id/reject`                         | Dismiss an unconfirmed proposal                                                     |
| POST   | `/portfolio/imports`                                    | Multipart `file`, `templateVersion`, optional `effectiveAt`, `expectedRevision`     |
| GET    | `/portfolio/imports/:id/preview`                        | Stored row errors or replacement preview                                            |
| POST   | `/portfolio/imports/:id/confirm`                        | Explicit full-replacement confirmation                                              |
| POST   | `/portfolio/baselines/:id/restore-preview`              | `{version:1, expectedRevision, idempotencyKey, effectiveAt}`; no immediate mutation |

Account creation uses `ACCOUNT_UPSERT` through the common change-preview route, rather than a separate immediate-write `/accounts` route. Event intents include the structured intents in `docs/04_PORTFOLIO_INPUTS.md`, plus explicit `STOCK_SHORT`/`STOCK_COVER` and `ACCOUNT_UPSERT`. No natural-language endpoint exists yet. The browser proxy allowlists paths/methods, bounds request bodies, and requires same-origin mutation requests; the API has no CORS and rejects direct browser-origin writes. CLI API requests use the private/internal API, not the browser proxy.

## Verification

```powershell
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
docker compose config --quiet
```

PostgreSQL integration tests require a disposable database and a role with CREATEDB permission. The M1 suite creates a uniquely named test database, runs additive migrations twice, and removes only that database afterward. M0 queue tests use the configured test database.

```powershell
docker run --name m2d-m1-integration --detach --publish 127.0.0.1:55433:5432 --env POSTGRES_DB=m2d_test --env POSTGRES_USER=m2d --env POSTGRES_PASSWORD=test-only postgres:17.6-bookworm
$env:TEST_DATABASE_URL='postgresql://m2d:test-only@127.0.0.1:55433/m2d_test'
pnpm test:integration
```

Browser tests write fictional portfolio records and therefore require explicit opt-in and a **fresh disposable** Compose project. Never point them at a real portfolio. Select a new project name for a fresh test run; do not wipe an existing workspace to make tests pass.

```powershell
$env:WEB_PORT='3100'
docker compose -p m2d-m1-e2e up --build --detach --wait --wait-timeout 180
$env:E2E_BASE_URL='http://127.0.0.1:3100'
$env:E2E_ALLOW_PORTFOLIO_WRITES='1'
pnpm exec playwright install chromium
pnpm test:e2e
docker compose -p m2d-m1-e2e down
Remove-Item Env:WEB_PORT,Env:E2E_BASE_URL,Env:E2E_ALLOW_PORTFOLIO_WRITES
```

Unit tests cover decimal/fee golden cases, option signs/settlements, input rejection, full replacement, and XLSX parsing. PostgreSQL tests cover migration idempotence, serialized/conflicting confirmations, expiry, backdating, failed-transaction rollback, replay, immutable history, duplicate imports and API validation. Browser tests cover real Excel upload and acknowledgment, manual cash preview/confirmation, missing-position replacement, retained history, origin rejection, narrow screens, and M0 operational regressions. CI runs these without provider keys.

## Deliberate limits

M1 rejects future dates and effective dates earlier than the latest confirmed boundary, including historical inserts between events. Use a documented current correction/replacement; automatic historical replay/reordering is not inferred. Corrections do not silently reverse the linked event.

Only standard physically settled 100-share equity/ETF options are supported. Adjusted deliverables, cash-settled/index options, unknown settlement, assignment-created stock shorts, and settlement into an existing stock short require explicit reconciliation. Expiration recording is after the UTC expiry date with user verification. No exchange calendar or market outcome is inferred.

Position/cash corrections are separate explicit changes; a position correction does not infer matching cash or profit. Transfers are same-currency only; no FX rate is invented. Split fractions do not infer cash-in-lieu. Account notes and reasons are audit evidence, not execution instructions. No tax lot reconstruction, historic return calculation, live valuation or general M2 chat functionality is included. Workbook-specific AI inference is the approved M1 extension described below.

Product-facing navigation and About copy describe portfolio tracking and decision records. Hosting characteristics (local or private cloud) belong in setup documentation, not product labels.

## Historical manual-mapping workflow (superseded UI)

The following section records the earlier deterministic mapping implementation and its retained compatibility API. Its manual controls are no longer rendered. The current user flow is Agent-assisted upload and clarification, described in **AI workbook parsing (M1 scope extension)** below.

The 2026-10-31 product clarification supersedes the original canonical-only M1 restriction. Users can upload an existing `.xlsx` with arbitrary tab names, column order and leading titles. Deterministic alias matching proposes headers and table ranges; ambiguous mappings remain editable. Every nonblank row must be assigned to a table, treated as an explicitly reviewed header, or explicitly excluded with a reason. Title exclusions are suggestions shown for review; unknown tabs and totals are never silently skipped. Multiple tables on one tab and USD/CAD cash columns are supported.

The review screen includes raw source rows (paged), header/data ranges, field-to-column mappings, defaults, row-specific corrections with reasons, and whole-tab exclusion. Header row `0` allows manually mapped headerless tables. Account names can come from columns or tab-name suggestions; normalized keys and all metadata are visible in the replacement diff. Existing exact account identifiers/names may supply account metadata. Unknown account base currency is inferred only when a single currency appears; multiple currencies require clarification.

Common aliases include ticker/symbol, qty/shares/contracts, average cost/average price, currency/CCY and cash balance. Current price, market value and buying power are not inferred to be cost basis or cash. Explicit total book cost can be divided by absolute quantity and contract multiplier using decimal arithmetic. Dollar symbols alone do not choose USD versus CAD; ambiguous locale separators are rejected. Standard OCC-style option strings and explicit ISO-date contract descriptions can provide expiry/right/strike/underlying, but contract size, deliverable and venue must be supplied or explicitly reviewed. Adjusted or unresolved contracts remain blocked.

If cash is absent from the file, enter a verified balance, including zero, in **Cash balances missing from the file**. This is preserved as a user clarification, not fabricated workbook evidence. Missing costs and security details can be supplied through mappings/defaults or row corrections. No values are silently set to zero to make an import pass.

Saved formula results may be reviewed with a visible warning; formulas are never evaluated. Formula cells without saved results block inspection until recalculated/saved or replaced by values. Macros and external links remain unsupported. The importer does not understand every possible layout automatically; unrecognized formats require mapping, not a hidden AI fallback. No M2 inference adapter is added.

Additional versioned routes:

- `GET /api/v1/portfolio/imports/:id/inspection`: original tabs, suggested or last-reviewed mappings, row errors and preview status.
- `POST /api/v1/portfolio/imports/:id/mapping`: `{version:1, expectedRevision, reviewed:true, mapping}`. Mapping v1 contains tables, explicit row exclusions, corrections and cash clarifications. The server parses the stored original file again and validates normalized state; the client cannot submit a replacement state directly.

Original file bytes remain immutable. Each interpretation stores its mappings, exclusions, manual clarifications, normalized data, row errors and source references in an immutable `portfolio_import_mappings` row. Changing a mapping (including an invalid revision) rejects earlier pending previews for that file. The final preview is bound to the file and reviewed mapping hash. A confirmed file cannot create another baseline using a different mapping; retries of the same confirmed interpretation return the original result. Confirmation remains a separate, explicit full-state replacement action with the existing revision/expiry safeguards.

Regression coverage includes reordered/mixed tabs, preambles, unknown rows, custom mappings, missing cash clarification, duplicate and subtotal handling, currency pivots, option decoding, decimal total-cost conversion, cached/unevaluated formulas, immutable mapping evidence and stale/superseded preview rejection. Browser verification covers arbitrary workbook inspection and preview without mutating portfolio state before confirmation.

### Immediate Excel imports (2026-10-31 UX revision)

Omitting `effectiveAt` selects confirmation-time effectiveness, persisted on the immutable import record. Preview timestamps represent preparation, not confirmation; the transaction assigns the effective timestamp when committing the baseline, projection revision and change log. Identical uploads and repeated confirmations retain their original identity and cannot advance the timestamp or revision twice. Existing explicitly dated imports retain their recorded timing policy. The canonical template endpoint and typed incremental APIs remain compatibility/testing facilities; their entry controls are removed from the UI. This supersedes the M1 manual-form deliverable without implementing M2 chat.

## AI workbook parsing (M1 scope extension)

The user moved workbook AI parsing into M1 on 2026-10-31. The manual interpretation component is preserved in source for compatibility but is no longer rendered. Generic chat and incremental natural-language updates remain M2.

Configure backend `.env` with `LLM_PROVIDER=openai`, `LLM_MODEL=gpt-5.4-mini-2026-03-17`, and `OPENAI_API_KEY`. Restart with `docker compose up --build --detach`. The key is passed only to API/worker runtime; it is never copied into images or sent to the browser. The configured model is explicitly allowlisted for structured output; an unsupported model/key/provider produces a setup error, never an offline or different-provider fallback. Status means configured, not a promise of account quota or availability.

`LLM_PROVIDER=fixture` / `LLM_MODEL=fixture-v1` uses the same extraction/validation contract with deterministic header inference and no network. It is visibly labeled offline fixture interpretation, cannot understand arbitrary clarifications, and never fabricates missing data. Tests and CI remain offline.

The browser uploads once, then calls `POST /api/v1/portfolio/imports/:id/parse` with `{version:1, expectedRevision, idempotencyKey, clarification, retry}`. Recognized canonical workbooks can still preview deterministically without a model call. AI parses the complete bounded sheet text, suggested layout and existing account metadata; workbook/clarification text is untrusted data, not execution instructions. It has no tools or SQL access. Generated mapping is internal only. Values outside mapped columns must match cited cells, sheet names, existing account metadata or literal user clarification. Explicit asset/account classifications are shown for review; a mislabeled classification is only recoverable when its value exactly matches the cited cell. Numeric values cannot be invented. The existing deterministic parser checks coverage, duplicates, currencies, decimals, missing cash and option terms. Uncertainty or invalid output blocks all portfolio mutation. Full-state replacement still requires acknowledgment, matching revision and a separate transactional confirmation.

Each run makes at most one model call (SDK retries disabled), with 120,000 serialized input characters, 12,000 output tokens, a 120-second timeout and one concurrent run across API instances via a PostgreSQL advisory lock. There is no dollar or daily spending cap configured; UI states this and the provider/data destination. OpenAI storage is disabled on the request (`store:false`). Refusals, incomplete output, invalid JSON, unsupported capabilities, authentication/quota/rate-limit errors and timeout do not create financial state. API errors expose safe messages only. A lost request can be retried using its original idempotency key. Identical successful input/provider/model/revision/policy reuses its audited response; explicit failed retries use fresh keys and are capped at three attempts per identical input. An interrupted process is recorded failed when revisited and requires explicit retry.

Migration 0004 adds import-run evidence with request/response, provider/model, prompt/schema/adapter versions, limits, usage where reported, safe provider request ID, timings and terminal status. Completed/failed runs and their requests are immutable; mapping validation and source rows remain in the existing immutable interpretation audit. General analysis modes do not apply to this fixed workbook policy. Canonical raw files, historical baselines and actual confirmation timestamps are preserved.

Verified API references: [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [GPT-5.4 mini capabilities and snapshot](https://developers.openai.com/api/docs/models/gpt-5.4-mini), [official TypeScript SDK](https://developers.openai.com/api/reference/typescript).

## Accounts, optional basis and Agent format memory (M1 clarification)

Portfolio state contains many broker/platform accounts, each with native-currency cash and stock/ETF or option holdings. Required holding fields are asset class, equity symbol and signed quantity. Description and cost base per unit are optional. Missing currency defaults to USD; an explicitly supplied recognized three-letter currency is retained. Missing unit cost is null with UNKNOWN quality, never zero; cost-dependent ledger calculations require a confirmed correction. Missing exchange is labeled UNKNOWN and does not authorize any live valuation.

Options remain individual contract legs. OptionGroup links legs of a spread without combining their quantities, basis or obligations. Standard 100-share deliverables must still be explicit; one row describing an entire spread without leg details needs clarification. Positions are netted by account and instrument, so independently tracking overlapping strategies with the same contract is not supported yet.

Agent is a closable panel on the right at widths of 1200px or more and a bottom window on smaller screens. Open Agent restores it; the browser remembers the closed preference. It collects cumulative upload clarifications and contains the preview, exclusions, full-replacement acknowledgement and confirmation action. Errors stay beside the affected operation. General trade/research chat remains M2.

Migration 0005 adds optional position description/group, nullable basis and immutable confirmed format-memory records. A validated mapping candidate is promoted only inside the successful confirmation transaction. Future uploads reuse it only when sheet names, headers/preamble and account identities match. Financial values are reread from the new file. Version 2 profiles can turn eligible classification/currency corrections into source-token rules and option-term corrections into symbol/description/type-matched rules. Raw row overrides, explicit cash corrections, quantities, costs and expiry dates are never copied into the reusable mapping. A changed or ineligible layout goes back through interpretation; no upload bypasses validation or confirmation. Identical request replay remains idempotent. Format memory currently searches the 100 newest confirmed rules; there is no memory-management UI.

## Shared Agent, account identity and holding dates

M1 Agent is mounted in the shared application layout and is available on every function page. Route navigation preserves the selected workbook file, typed draft, account choices, conversation, preview and acknowledgement in the current browser session. Closing the panel does not discard work. A full browser refresh/reopen is not a saved-draft recovery mechanism; persisted imports, confirmed aliases and history remain in PostgreSQL. Research, opportunity analysis and natural-language trade execution remain outside M1.

An unfamiliar account-bearing worksheet now requires an explicit **new account** or **rename existing account** choice before model dispatch. Rename retains accountKey and historical records and changes the display name only in the confirmed full-replacement transaction. The account selector shows broker and stable ID to disambiguate identically named accounts. Worksheets with explicit account columns use those identifiers instead of treating the worksheet name as an account. Confirmed, case-insensitive tab aliases persist in PostgreSQL; unconfirmed choices do not. Old aliases retain the current display name instead of silently renaming an account back. A new account choice that collides with an existing identity is rejected. Multiple tabs targeting one account currently require consolidation or explicit account-column layouts.

`POST /api/v1/portfolio/imports/:id/parse` accepts optional `accountDecisions: [{sheet,kind:"new"}|{sheet,kind:"rename",accountKey}]`; unresolved identity returns `ai.accountQuestions` with available account choices and no preview/model call. Choices are included in the idempotency fingerprint and immutable mapping audit. The final diff remains the separate financial confirmation gate.

Positions accept optional `transactionDate` (ISO YYYY-MM-DD). Excel aliases include Transaction date, Trade date, Purchase date and Acquisition date; formatted Excel dates are read as calendar dates. Ambiguous text dates must be clarified. This date is snapshot metadata only: it neither delays import effectiveness nor establishes lot-level trade history, tax basis or realized P&L. Migration 0006 adds the DATE projection column and confirmed account-alias table. Existing snapshots remain valid without the optional field. Canonical exports include the field while older canonical headers are still accepted.

Agent asks questions once, identifies the relevant sheet/row/field and gives permitted answers or a concrete reply example. The input hint refers to the current question instead of showing an unrelated cash/currency example.

The implemented database schema is documented in [ERD.md](ERD.md). Regenerate it with `pnpm docs:erd`; CI runs `pnpm docs:erd:check` to catch schema/documentation drift.

## Function-specific Agent conversations

Agent now labels its active context (for example Agent · Portfolio or Agent · Research) and restores a separate conversation and unsent draft for every navigation function. Portfolio file selection, account choices, pending requests, errors, preview and acknowledgement remain attached to Portfolio and are hidden elsewhere. Async portfolio replies always enter the Portfolio conversation even when another function is active. A return link identifies unfinished Portfolio work; navigation never confirms, rejects or cancels it. Closing Agent preserves all contexts.

In M1, other functions support clearly labelled session notes and drafts only. Saving a note does not invoke a model, perform analysis or mutate portfolio state; each function states its planned milestone. These notes and conversations survive navigation and close/reopen within the current page session, not a browser reload. Confirmed portfolio data remains shared authoritative state, rather than being copied into separate financial ledgers. No database schema change is required; the ERD remains unchanged.

Model row-specific bindings accidentally placed in table defaults are normalized into row overrides before validation. Duplicate bindings are independently grounded and coalesced only when their validated values agree; conflicting values remain blocking parser errors. Model-generated expiry citations for yearless option descriptions do not bypass the current-year policy. Omitted whole-sheet tables may be restored only from recognized current-workbook asset-class/symbol/quantity columns, and never over explicit exclusions. Remaining uncovered rows block import with a retry action. Invalid output is never presented as a user question or a harmless review notice; no financial state changes until the complete preview is confirmed.

Account decisions are validated against the original inspected workbook as well as any newly discovered tables. A model omitting or excluding a reviewed tab cannot invalidate an already accepted new/rename choice. Incomplete mappings still block preview creation; account identity validation does not waive row coverage. The web client allows only one operation in flight and suppresses repeated account-choice clicks before logging or sending another request.
