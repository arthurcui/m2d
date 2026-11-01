# Public research sources (M4 extension)

Research → select a ticker → **Sources**. Import a preset, browse its document links, or save a public HTTPS URL under a company. Saving a link does not fetch or index it. Imported evidence is shared by the user search screen and Agent, with source filters, passage citations and historical availability. No portfolio changes follow from research.

| Category                     | Included inputs                                                                                     | Important distinction                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Company / investor relations | Public issuer releases, shareholder decks, HTML/text/PDF reports and RSS/Atom feeds                 | Issuer claims need independent assessment. Webcasts are not transcribed.                                                                 |
| ETF / fund documents         | Issuer pages, prospectuses, fact sheets and public holdings CSVs (searched as text)                 | Fund objectives, leverage/reset rules, expenses and holdings snapshots; not the user's portfolio.                                        |
| Options notices              | Public OCC directory/memo links and uploaded permitted copies                                       | Import the exact memo and verify contract/symbol/deliverable applicability. No automatic adjustment or assumption of standard terms.     |
| Economic releases            | Federal Reserve/BLS calendars, monetary policy and inflation/employment feeds; linked full releases | Market-wide context attached to the selected company, not company-specific news. Feed contents can change.                               |
| Financial news               | Massive Stock News endpoint, using the existing backend key; other saved public article/feed URLs   | Massive supplies at most five matching publisher summaries and original links per request, not full articles. Basic news updates hourly. |

Curated issuer examples cover Tesla and NVIDIA; the Tesla Q3 2026 deck is explicitly dated, not a permanently latest-report link. Direxion's TSLL/TSLS page covers both funds: select the relevant document. Other issuers/funds can be added by URL. Arbitrary issuer discovery, broker research subscriptions and paid transcript services are not implemented. A user-assigned category does not authenticate the publisher.

## Configuration and cost

`RESEARCH_SOURCE_MODE=fixture` is the default for offline development and CI. Preset and saved-link imports produce clearly labeled synthetic evidence and make no external calls. `RESEARCH_SOURCE_MODE=live` enables real public HTTP retrieval. This setting is independent of `RESEARCH_PROVIDER=fixture|sec`, which controls EDGAR imports. SEC still requires a genuine contact identity in `SEC_USER_AGENT`.

Massive reuses `MASSIVE_API_KEY` on the API backend. The key is never returned to the browser, appended to evidence URLs or forwarded on redirects. No additional account/key is needed for the other supported public sources. News consumes the same provider entitlement/rate quota as market-data calls; HTTP 429 is reported without retry storms or switching providers. Availability and licensing remain publisher-specific; content requiring authentication/paywall access is not bypassed.

Retrieval and keyword search do not invoke an LLM. **Build / resume semantic index** and Agent questions use the existing configured inference provider and deployment budgets. These remain explicit user operations. Continuous polling, discovery/scheduling, change-triggered alerts and automatic semantic indexing are future milestones, not part of this extension.

## Preservation and bounds

- Original response bytes, SHA-256, URL, category, publication time when known, observation time, revision and `available_at` are retained. Availability is no earlier than observation or declared publication. Dates inside feeds do not backdate a newly observed snapshot.
- Same source URL and identical content deduplicate; changed content creates a new revision. Removing a saved link never deletes evidence. Existing EDGAR/upload idempotency keys remain valid after this extension.
- RSS/Atom originals are preserved in full within the size limit, but search extraction is limited to the first 30 entries. Each entry includes its original link and supplied date. Browse results are also limited to 30. Import a linked report for its full text. Feed/document coverage is partial, not proof that no other material exists.
- Massive's exact JSON response is archived as an `INDEX` document. Only ticker-matching publisher metadata becomes searchable summary documents. Provider sentiment is not promoted to a fact; the backend rejects any response echoing the configured secret.
- Downloads allow public HTTPS/443 only, reject embedded credentials and signed/token URLs, validate all DNS results, pin the connection to a public address, revalidate redirects, limit responses to 12 MiB, and use a 20-second request budget. PDF extraction retains the existing isolated 30-second/200-page limits. CSVs are evidence text; there is no fund-holdings normalization or portfolio ingestion from these sources.
- Unsupported content, access challenges, HTTP failures and parse errors preserve previously stored evidence. Document content is untrusted data; it cannot direct tool use or financial changes.

`research_source_links` stores company-scoped URL preferences without requiring an imported company row. The symbol is a logical association: users may save links before the first import. Core entity and evidence relationships are generated in [ERD.md](ERD.md).

## Versioned HTTP contracts

All POST bodies require `version: 1`. Existing same-origin protections apply.

| Endpoint                                   | Body/query and behavior                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `GET /api/v1/research/sources?symbol=TSLA` | Mode, saved links and configured presets                                            |
| `POST /api/v1/research/sources`            | `symbol, kind, name, url`; idempotent upsert by symbol/category/URL                 |
| `POST /api/v1/research/sources/remove`     | Saved-link UUID; idempotent removal, evidence retained                              |
| `POST /api/v1/research/sources/discover`   | `symbol` plus exactly one `preset` ID or `link`; returns public document candidates |
| `POST /api/v1/research/sources/import`     | Same selection plus UUID `idempotencyKey`; returns durable import ID/status         |

`link` contains `symbol, kind, name, url`. Categories are `ir, fund, occ, macro, news`. Selecting a different company cannot repurpose a saved link silently. News API authentication is available only through the fixed Massive preset; arbitrary URLs never receive the key. The shared v2 search contract accepts these categories in `source`.

## Repeatable verification

Use a disposable PostgreSQL/pgvector server, never the application database:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://m2d:test-only@127.0.0.1:55434/m2d_test'
pnpm eval:research-sources
# Explicit opt-in: public network requests, configured Massive key, bounded OpenAI usage.
pnpm eval:research-sources --live
```

The harness creates/drops its own randomly named database, preserves original hashes, checks source categories and availability, indexes the small TSLL corpus, executes shared hybrid search and a cited Agent question, and verifies no financial state changes. It never reads the actual portfolio. Live ceilings are the lesser of deployment limits and USD 0.25, 20,000 embedding input bytes, five model attempts, four tools, 1,024 output tokens and 45 seconds per Agent run. Known model pricing is reused only for the supported mini model; other models need configured pricing. Per-source failures remain visible even when the rest of the pipeline passes. Reports and usage are saved under ignored `.tmp/research-sources-*-report.json`.

Live checks on November 1, 2026 imported Tesla’s Q3 deck, NVIDIA releases, Direxion’s fact sheet, Fed policy and BLS CPI/employment feeds, and five Massive summaries. All 12 stored-document hashes were verified. Hybrid retrieval and a real OpenAI Agent answer about TSLL daily compounding passed with citations and no financial changes. Index/query usage was 12,030 bytes / 2,793 embedding tokens; the Agent used 37,982 input and 844 output tokens.

OCC directory and memo requests returned HTTP 403, so live OCC ingestion is **not verified**. Tesla’s IR landing page also returned 403, while its separately published public deck downloaded successfully. SEC remains unverified until a genuine contact identity is configured. Blocked sites require a user-provided permitted document or another accessible official source; there is no authentication/access-control workaround.

The official Fed meeting calendar and BLS current release calendar also downloaded and parsed successfully (11 and 6 passages respectively); these are research snapshots, not automated reminders.

Final verification: 182 unit tests, 47 PostgreSQL/API integration tests and 33 Playwright tests passed. Formatting, lint, strict TypeScript checks, ERD consistency, Compose validation and all application image builds passed. The final local deployment passed desktop/mobile read-only checks with zero browser errors and all four services healthy. The recorded portfolio, holdings/cash and saved provider/analysis preferences were unchanged. A database backup was taken before the additive migration; live test documents stayed in disposable databases. The browser checks also exposed and fixed a pending-conversation-reset race that could erase the next typed message.
