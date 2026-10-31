# 04 — Portfolio Input Contracts: Natural Language and Excel

## 1. Two explicit modes
**A. Natural-language incremental events:** user says what occurred in a specific account. LLM parses **candidate operation only**, domain service checks holdings/cash/contracts, renders exact before/after preview, user confirms, DB appends event and refreshes projection atomically.

**B. Excel authoritative full replacement:** upload entire workbook listing all accounts, positions and cash. Parse to temporary staging, validate, show detailed diff, user confirms, DB writes new baseline+rows and updates all projections in a single DB transaction. Old state is preserved historically. **No accidental merge.**

## 2. Recommended canonical workbook
Create a downloadable `M2D_Portfolio_Template.xlsx` during implementation (not part of this design-only pack) with 3 required sheets:

`Accounts`:
`AccountKey | DisplayName | Institution | AccountType | BaseCurrency | Active | Notes`

`Positions`:
`AccountKey | AssetType | Symbol | Exchange | Currency | Quantity | AverageCost | OptionRight | Expiration | Strike | Multiplier | Underlying | Deliverable | Notes`

`Cash`:
`AccountKey | Currency | Balance`

Rules:
- A workbook is a **complete universe of accounts, positions, and cash** as of `as_of` timestamp submitted at upload. `AccountKey` stable across imports. Include explicitly zero balances for base currencies in each account; extra currencies can be listed as needed. Missing legacy currencies shown as zeroed in preview.
- Position rows may be empty for an account; zero/unlisted positions represent no holding. Absent accounts are deactivated (not deleted) with preview warning.
- `Quantity` is signed: short options negative. AverageCost is nonnegative price per stock share / option underlying quote-unit, denominated in explicit `Currency`; cost accuracy flag may be inferred from sheet level, never asserted complete.
- Options: Put/Call, expiry as unambiguous YYYY-MM-DD, strike, multiplier and underlying mandatory. Validate OCC-like contract representation; reject ambiguous corporate-action-adjusted contracts pending explicit deliverable.
- Reject duplicate instrument+account rows unless documented consolidation mapping used; reject duplicate account keys, unsupported currencies, malformed dates, formula-only unevaluated data, NaN and nonfinite numbers.
- Calculate SHA-256 file hash and import idempotency; exact duplicate upload cannot accidentally create another baseline.
- Version schema with `TemplateVersion`, upload as_of and declared scope in an `ImportInfo` worksheet or UI metadata. The canonical template is optional. Per the 2026-10-31 product clarification, M1 also accepts arbitrary tab names and column layouts through an inferred, user-reviewed mapping step. No inference API is required.

### Preview example
- Added accounts: 1; deactivated: 0.
- TSLA / IBKR Margin: 50 -> 100 shares.
- Short TSLL 2026-10-30 C 11.50 / Questrade RRSP: -1 -> 0 contracts.
- IBIT / Questrade TFSA: 100 -> 0 shares.
- USD cash / IBKR Margin: 12,000 -> 18,800.
- Highlight any removal, account disappearance, date/FX concerns, missing costs, unknown contracts.

## 3. Natural-language commands and schema
Supported intents: `STOCK_BUY`, `STOCK_SELL`, `OPTION_BTO`, `OPTION_STO`, `OPTION_BTC`, `OPTION_STC`, `OPTION_EXPIRE`, `OPTION_ASSIGN`, `OPTION_EXERCISE`, `CASH_SET`, `CASH_DEPOSIT`, `CASH_WITHDRAW`, `CASH_TRANSFER`, `DIVIDEND`, `FEE`, `SPLIT`, `ADJUST_POSITION`, `NOTE_ONLY`.

Typed parse output (conceptual):
```json
{
  "intent": "OPTION_STO",
  "accountKey": "Questrade_RRSP",
  "symbol": "TSLL",
  "option": {"right": "CALL", "expiry": "2026-11-20", "strike": "12.00", "multiplier": "100"},
  "contracts": "1",
  "premiumPerShare": "0.85",
  "fees": "0.65",
  "currency": "USD",
  "effectiveAt": "2026-10-30T20:00:00Z",
  "clarifications": [],
  "confidence": "HIGH"
}
```
Numbers are serialized decimal **strings**. The LLM should return `clarifications` when necessary; exact expiry, action side and account are never guessed. Omitted effectiveAt may default to `now`, but UI must show the assumed date/time before confirmation. A user saying "buy 100 TSLA" with no price requires a price clarification, not a fabricated fill.

## 4. State change lifecycle
1. `parse -> preview`: no mutations; record a short-lived preview with hash, expected revision, normalized changes, warnings and expiry.
2. UI shows readable before/after holdings and native cash effect; user presses **Confirm**.
3. `confirm`: single DB transaction checks expected revision and idempotency, appends events or baseline and updates projections; add row to change log.
4. Status `CONFIRMED`, `EXPIRED`, `REJECTED`, or `CONFLICT`; rejected/stale preview cannot be re-submitted without refresh.
5. Corrections: create compensating/reversal events with link to previous operation; new full baselines supersede projections but do not erase history.

## 5. Sample acceptance cases
- "Sold 1 TSLA Oct 30 420 call @ $6 in Questrade" must ask for year if ambiguous and not infer which account if duplicate.
- "IBKR RRSP add $5,000 USD cash" must distinguish deposit from balance correction; if user says "cash now $5,000", interpret `CASH_SET`, not deposit.
- Re-upload exactly the same Excel -> no-op detection.
- Missing old position in Excel -> current qty 0 on confirm, but no synthetic sell transaction or realized P&L.
- Upload fails row 137 -> no partial DB changes.
- An old natural-language confirmation link after newer Excel revision -> revision conflict.

## M1 executable contract

See [M1_PORTFOLIO.md](M1_PORTFOLIO.md#canonical-workbook-v1) for the shipped template, bounded USD/CAD and standard-option support, explicit metadata fields, upload limits, and conservative backdating policy. Canonical workbooks use the three template sheets; other workbooks are inspected tab-by-tab, mapped, validated, and reviewed before full replacement. Metadata is supplied in the upload UI. Structured entry implements the ledger intents without an LLM. Unsupported contracts are rejected for explicit reconciliation.

## M1 user clarification: account hierarchy and import Agent

The implemented model is portfolio -> broker/platform accounts -> cash and holdings. Asset class, equity symbol and quantity are required; description and unit cost are optional. Omitted currency defaults to USD, explicit other recognized currencies are supported, and missing cost is stored as unknown. Multi-leg options retain per-contract rows linked by OptionGroup. The responsive Agent handles import questions and explicit full-replacement confirmation. Safe confirmed format mappings persist in PostgreSQL and are reused only for matching layout/account evidence; new financial values are always reread. See M1_PORTFOLIO.md and ADR-030 for exact constraints. This supersedes earlier template-only, mandatory-cost and USD/CAD-only assumptions for M1 uploads.
