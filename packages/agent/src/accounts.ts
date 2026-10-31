import { createHash } from 'node:crypto';
import {
  PortfolioError,
  type AccountDecision,
  type State,
  type WorkbookInspection,
  type WorkbookMapping,
} from '@m2d/portfolio';
type Alias = { sheetName: string; accountKey: string };
const norm = (s: string) => s.trim().toLowerCase();
const keyFor = (s: string) =>
  s
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .slice(0, 64) ||
  `account_${createHash('sha256').update(s).digest('hex').slice(0, 12)}`;
export function accountBindings(
  inspection: WorkbookInspection,
  accounts: State['accounts'],
  aliases: Alias[],
  decisions: AccountDecision[],
) {
  const names = [
    ...new Set(
      inspection.mapping.tables
        .filter(
          (t) =>
            t.kind !== 'accounts' &&
            t.columns.AccountKey === undefined &&
            (t.kind !== 'unresolved' ||
              decisions.some((d) => d.sheet === t.sheet)),
        )
        .map((t) => t.sheet),
    ),
  ];
  if (
    new Set(decisions.map((d) => d.sheet)).size !== decisions.length ||
    decisions.some((d) => !names.includes(d.sheet))
  )
    throw new PortfolioError(
      'INVALID_ACCOUNT_CHOICE',
      'Choose once for each listed account tab.',
    );
  const bindings: {
      sheet: string;
      accountKey: string;
      displayName: string;
      existing?: State['accounts'][number];
    }[] = [],
    pending: string[] = [];
  for (const sheet of names) {
    const decision = decisions.find((d) => d.sheet === sheet);
    const matches = accounts.filter(
      (a) =>
        norm(a.accountKey) === norm(sheet) ||
        norm(a.displayName) === norm(sheet) ||
        aliases.some(
          (alias) =>
            norm(alias.sheetName) === norm(sheet) &&
            alias.accountKey === a.accountKey,
        ),
    );
    const known = matches.length === 1 ? matches[0] : undefined;
    if (decision?.kind === 'rename') {
      const target = accounts.find((a) => a.accountKey === decision.accountKey);
      if (!target)
        throw new PortfolioError(
          'INVALID_ACCOUNT_CHOICE',
          `Choose an existing account for tab "${sheet}".`,
        );
      bindings.push({
        sheet,
        accountKey: target.accountKey,
        displayName: sheet,
        existing: target,
      });
    } else if (decision?.kind === 'new') {
      const key = keyFor(sheet);
      if (
        matches.length > 0 ||
        accounts.some((a) => a.accountKey === key) ||
        bindings.some((b) => b.accountKey === key)
      )
        throw new PortfolioError(
          'INVALID_ACCOUNT_CHOICE',
          `Tab "${sheet}" conflicts with an existing account identifier. Choose rename or use a distinct tab name.`,
        );
      bindings.push({ sheet, accountKey: key, displayName: sheet });
    } else if (known)
      bindings.push({
        sheet,
        accountKey: known.accountKey,
        displayName: known.displayName,
        existing: known,
      });
    else pending.push(sheet);
  }
  if (new Set(bindings.map((b) => b.accountKey)).size !== bindings.length)
    throw new PortfolioError(
      'INVALID_ACCOUNT_CHOICE',
      'Two tabs point to the same account. Combine that account into one tab before importing, or choose separate accounts.',
    );
  return { bindings, pending };
}
export function bindAccountMapping(
  mapping: WorkbookMapping,
  bindings: ReturnType<typeof accountBindings>['bindings'],
  decisions: AccountDecision[],
): WorkbookMapping {
  const result = structuredClone(mapping);
  result.accountDecisions = decisions;
  for (const binding of bindings) {
    for (const table of result.tables.filter(
      (t) => t.sheet === binding.sheet,
    )) {
      delete table.columns.AccountKey;
      delete table.columns.DisplayName;
      Object.assign(table.defaults, {
        AccountKey: binding.accountKey,
        DisplayName: binding.displayName,
      });
      if (binding.existing) {
        const account = binding.existing;
        table.defaults.AccountType = account.accountType;
        table.defaults.BaseCurrency = account.baseCurrency;
        if (account.institution)
          table.defaults.Institution = account.institution;
        else delete table.defaults.Institution;
      }
    }
    for (const row of result.overrides.filter(
      (r) => r.sheet === binding.sheet,
    )) {
      delete row.values.AccountKey;
      delete row.values.DisplayName;
    }
  }
  return result;
}
