import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import {
  accountSchema,
  positionSchema,
  cashSchema,
  stateSchema,
  amount,
  emptyState,
  instrumentKey,
  workbookMappingSchema,
  type Account,
  type WorkbookInspection,
  type WorkbookMapping,
  type ImportField,
  type ImportTable,
  type ImportSource,
} from '@m2d/portfolio';
import { readTables } from './reader.js';
import type { ImportResult, RowError } from './index.js';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const aliases: Partial<Record<ImportField, string[]>> = {
  AccountKey: [
    'account',
    'account key',
    'account id',
    'account number',
    'account no',
    'account name',
    'portfolio',
    'portfolio name',
  ],
  DisplayName: ['display name'],
  Institution: ['institution', 'broker', 'brokerage'],
  AccountType: ['account type'],
  BaseCurrency: ['base currency', 'account currency'],
  Active: ['active'],
  AssetType: ['asset type', 'security type', 'instrument type', 'asset class'],
  Symbol: [
    'equity symbol',
    'symbol',
    'ticker',
    'ticker symbol',
    'security symbol',
    'instrument',
    'contract',
  ],
  Description: [
    'description',
    'equity description',
    'security description',
    'security name',
  ],
  TransactionDate: [
    'transaction date',
    'trade date',
    'purchase date',
    'acquisition date',
  ],
  Exchange: ['exchange', 'venue', 'listing exchange', 'primary exchange'],
  Currency: ['currency', 'ccy', 'curr', 'denomination'],
  Quantity: [
    'quantity',
    'qty',
    'shares',
    'contracts',
    'units',
    'position',
    'position quantity',
    'holding',
  ],
  AverageCost: [
    'cost base per unit',
    'cost basis per unit',
    'average cost',
    'avg cost',
    'avg price',
    'average price',
    'cost price',
    'cost per share',
    'book cost per share',
    'unit cost',
  ],
  TotalCost: ['total cost', 'book value', 'total book cost'],
  Balance: ['balance', 'cash balance', 'cash amount', 'settled cash'],
  OptionRight: ['option right', 'put call', 'call put', 'option type', 'right'],
  Expiration: [
    'expiration',
    'expiry',
    'expiry date',
    'expiration date',
    'maturity',
  ],
  Strike: ['strike', 'strike price'],
  Multiplier: ['multiplier', 'contract size'],
  Underlying: ['underlying', 'underlying symbol'],
  Deliverable: ['deliverable'],
  Side: ['position side', 'long short', 'side'],
  OptionGroup: [
    'option group',
    'strategy group',
    'strategy',
    'spread',
    'spread id',
    'group',
  ],
  Notes: ['notes', 'note', 'memo'],
};
function columnMap(row: string[]) {
  const columns: ImportTable['columns'] = {};
  const ambiguous: string[] = [];
  for (const [field, names] of Object.entries(aliases)) {
    const indices = row.flatMap((v, i) =>
      names.some((n) => norm(n) === norm(v)) ? [i] : [],
    );
    if (indices.length === 1) columns[field as ImportField] = indices[0]!;
    if (indices.length > 1) ambiguous.push(field);
  }
  return { columns, ambiguous };
}
const accountKey = (v: string) =>
  v
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) ||
  `account_${createHash('sha256').update(v).digest('hex').slice(0, 12)}`;
const nonblank = (r: string[]) => r.some((v) => v.trim() !== '');
export async function inspectWorkbook(
  bytes: Buffer,
  accounts: Account[] = [],
): Promise<WorkbookInspection> {
  const { sheets, warnings } = await readTables(bytes, true);
  const mapping: WorkbookMapping = {
    version: 1,
    accountDecisions: [],
    cashBalances: [],
    tables: [],
    excludedRows: [],
    overrides: [],
  };
  for (const sheet of sheets) {
    const candidates = sheet.rows.flatMap((row, i) => {
      const map = columnMap(row),
        c = map.columns;
      const pivot = row.some((v) => /^(USD|CAD)( cash)?$/i.test(v.trim()));
      return (Object.keys(c).length >= 2 &&
        (c.Symbol !== undefined ||
          c.Quantity !== undefined ||
          c.Balance !== undefined ||
          c.DisplayName !== undefined ||
          c.AccountType !== undefined)) ||
        (pivot && c.AccountKey !== undefined)
        ? [{ row: i + 1, ...map }]
        : [];
    });
    if (!candidates.length) {
      if (sheet.rows.some(nonblank))
        mapping.tables.push({
          sheet: sheet.name,
          headerRow: 1,
          firstRow: 2,
          lastRow: sheet.rows.length,
          kind: 'unresolved',
          columns: {},
          defaults: {},
        });
      continue;
    }
    for (const [idx, candidate] of candidates.entries()) {
      const c = candidate.columns;
      const positions = c.Symbol !== undefined || c.Quantity !== undefined;
      const kind: ImportTable['kind'] = positions
        ? 'mixed'
        : c.Balance !== undefined
          ? 'cash'
          : c.AccountType !== undefined || c.DisplayName !== undefined
            ? 'accounts'
            : 'unresolved';
      const defaults: ImportTable['defaults'] = {};
      if (c.AccountKey === undefined) {
        const known = accounts.find(
          (a) =>
            norm(a.accountKey) === norm(sheet.name) ||
            norm(a.displayName) === norm(sheet.name),
        );
        if (known) {
          defaults.AccountKey = known.accountKey;
          defaults.DisplayName = known.displayName;
          defaults.BaseCurrency = known.baseCurrency;
          defaults.AccountType = known.accountType;
          if (known.institution) defaults.Institution = known.institution;
        } else if (
          !/^(positions|holdings|cash|balances|stocks|options|sheet\d*)$/i.test(
            sheet.name.trim(),
          )
        ) {
          defaults.AccountKey = accountKey(sheet.name);
          defaults.DisplayName = sheet.name;
        }
      }

      if (c.AccountType === undefined && /rrsp|tfsa/i.test(sheet.name))
        defaults.AccountType = /rrsp/i.test(sheet.name) ? 'RRSP' : 'TFSA';
      if (candidate.ambiguous.length)
        warnings.push(
          `${sheet.name}, row ${candidate.row}: multiple columns could mean ${candidate.ambiguous.join(', ')}; choose the intended column.`,
        );
      const table: ImportTable = {
        sheet: sheet.name,
        headerRow: candidate.row,
        firstRow: candidate.row + 1,
        lastRow: (candidates[idx + 1]?.row ?? sheet.rows.length + 1) - 1,
        kind,
        columns: c,
        defaults,
      };
      const pivot = sheet.rows[candidate.row - 1]!.flatMap((v, i) =>
        /^(USD|CAD)( cash)?$/i.test(v.trim())
          ? [{ column: i, currency: v.trim().slice(0, 3).toUpperCase() }]
          : [],
      );
      if (!positions && c.Balance === undefined && pivot.length) {
        for (const p of pivot)
          mapping.tables.push({
            ...table,
            kind: 'cash',
            columns: { ...c, Balance: p.column },
            defaults: { ...defaults, Currency: p.currency },
          });
      } else mapping.tables.push(table);
    }
    for (let row = 1; row < candidates[0]!.row; row++)
      if (nonblank(sheet.rows[row - 1]!))
        mapping.excludedRows.push({
          sheet: sheet.name,
          row,
          reason: 'Detected title/preamble — review before excluding',
        });
  }
  warnings.push(
    'Review proposed account identities, security types, all defaults, and excluded rows. A sheet name may suggest an account; it is not a verified account identifier.',
    'Every nonblank row must be mapped or explicitly excluded. Totals and unrelated tabs are never silently discarded.',
    'Asset class, equity symbol and quantity are required. Currency defaults to USD; absent cost and exchange remain unknown. Cash and option terms must be explicit; standard 100-share options require Multiplier and Deliverable.',
  );
  return { sheets, mapping, warnings };
}
function decimal(value: string, currency?: string): string {
  let v = value.trim();
  let negative = false;
  if (/^\(.*\)$/.test(v)) {
    negative = true;
    v = v.slice(1, -1).trim();
  }
  const unit = v.match(/^([A-Z]{3}|US\$|C\$)\s*|\s*([A-Z]{3})$/i);
  if (unit) {
    const found = (unit[1] ?? unit[2]!)
      .toUpperCase()
      .replace('US$', 'USD')
      .replace('C$', 'CAD');
    if (found !== currency)
      throw new Error(
        `Amount currency ${found} differs from the mapped currency.`,
      );
    v = v.replace(unit[0], '').trim();
  }
  if (v.startsWith('$')) {
    if (!currency)
      throw new Error('A dollar symbol does not identify USD versus CAD.');
    v = v.slice(1).trim();
  }
  if (v.includes(',')) {
    if (!/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(v))
      throw new Error(
        'Ambiguous decimal/grouping separators; provide a decimal-point value.',
      );
    v = v.replaceAll(',', '');
  }
  if (negative) {
    if (v.startsWith('-')) throw new Error('Conflicting amount signs.');
    v = `-${v}`;
  }
  return amount.parse(v);
}
function contract(
  symbol: string,
  description: string,
): {
  Underlying: string;
  Expiration: string;
  OptionRight: string;
  Strike: string;
} | null {
  const occ = (symbol || description)
    .trim()
    .match(/^([A-Z]{1,6})\s*(\d{2})(\d{2})(\d{2})([CP])(\d{5})(\d{3})$/i);
  if (occ)
    return {
      Underlying: occ[1]!.toUpperCase(),
      Expiration: `20${occ[2]}-${occ[3]}-${occ[4]}`,
      OptionRight: occ[5]!.toUpperCase() === 'C' ? 'CALL' : 'PUT',
      Strike: amount.parse(`${occ[6]}.${occ[7]}`),
    };
  const text = (symbol || description)
    .trim()
    .match(
      /^([A-Z.]{1,24})\s+(\d{4}-\d{2}-\d{2})\s+(\d+(?:\.\d+)?)\s+(CALL|PUT|C|P)$/i,
    );
  if (text)
    return {
      Underlying: text[1]!.toUpperCase(),
      Expiration: text[2]!,
      OptionRight: /^C/i.test(text[4]!) ? 'CALL' : 'PUT',
      Strike: amount.parse(text[3]!),
    };
  return description && description !== symbol
    ? contract(description, '')
    : null;
}
export async function resolveWorkbook(
  bytes: Buffer,
  rawMapping: WorkbookMapping,
  existing: Account[] = [],
  now = new Date(),
): Promise<ImportResult & { sources: ImportSource[]; warnings: string[] }> {
  const mapping = workbookMappingSchema.parse(rawMapping),
    inspection = await readTables(bytes, true),
    state = emptyState(),
    errors: RowError[] = [],
    sources: ImportSource[] = [],
    assumptionWarnings: string[] = [];
  const currentYear = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Vancouver',
    year: 'numeric',
  }).format(now);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const addError = (
    sheet: string,
    row: number,
    field: string,
    message: string,
  ) => errors.push({ sheet, row, field, message });
  const rowId = (sheet: string, row: number) => JSON.stringify([sheet, row]);
  const covered = new Set<string>(),
    excluded = new Set<string>();
  const sheetMap = new Map(inspection.sheets.map((s) => [s.name, s]));
  const overrides = new Map<string, WorkbookMapping['overrides'][number]>();
  for (const o of mapping.overrides) {
    const id = rowId(o.sheet, o.row);
    if (overrides.has(id))
      addError(o.sheet, o.row, 'override', 'Duplicate row override.');
    overrides.set(id, o);
  }
  for (const e of mapping.excludedRows) {
    if (!sheetMap.get(e.sheet)?.rows[e.row - 1])
      addError(e.sheet, e.row, 'excluded', 'Excluded row does not exist.');
    excluded.add(rowId(e.sheet, e.row));
  }
  type AccountDraft = {
    name: string;
    data: Record<string, string>;
    currencies: Set<string>;
  };
  const drafts = new Map<string, AccountDraft>();
  const register = (
    raw: string,
    v: Record<string, string>,
    sheet: string,
    row: number,
  ) => {
    if (!raw.trim())
      throw new Error(
        'Account is missing. Map an account column or supply an account default.',
      );
    if (/^(total|subtotal|grandtotal|allaccounts)$/i.test(norm(raw)))
      throw new Error(
        'This looks like an account aggregate. Exclude the summary row or supply its verified account identity explicitly.',
      );
    const known = existing.find(
      (a) => a.accountKey === raw || a.displayName === raw,
    );
    const key = known?.accountKey ?? accountKey(raw),
      previous = drafts.get(key);
    if (previous && previous.name !== raw)
      throw new Error(
        `Account names ${previous.name} and ${raw} collapse to the same key; explicitly map a single stable identity.`,
      );
    const data: Record<string, string> = {
      DisplayName: known?.displayName ?? raw,
      Institution: known?.institution ?? '',
      AccountType: known?.accountType ?? 'OTHER',
      BaseCurrency: known?.baseCurrency ?? '',
      Active: 'TRUE',
      Notes: '',
      ...previous?.data,
      ...Object.fromEntries(
        Object.entries(v).filter(
          ([k, val]) =>
            [
              'DisplayName',
              'Institution',
              'AccountType',
              'BaseCurrency',
              'Active',
              'Notes',
            ].includes(k) && val !== '',
        ),
      ),
    };
    if (previous) {
      for (const k of [
        'DisplayName',
        'Institution',
        'AccountType',
        'BaseCurrency',
        'Active',
      ])
        if (previous.data[k] && data[k] && previous.data[k] !== data[k])
          addError(
            sheet,
            row,
            k,
            `Conflicting metadata for ${key}; align the mappings.`,
          );
      for (const [k, val] of Object.entries(data))
        if (!previous.data[k] && val) previous.data[k] = val;
      if (v.Currency) previous.currencies.add(v.Currency);
    } else
      drafts.set(key, {
        name: raw,
        data,
        currencies: new Set(v.Currency ? [v.Currency] : []),
      });
    return key;
  };
  const positionKeys = new Set<string>(),
    cashKeys = new Set<string>();
  for (const table of mapping.tables) {
    const sheet = sheetMap.get(table.sheet);
    if (!sheet) {
      addError(table.sheet, 0, 'sheet', 'Sheet not found.');
      continue;
    }
    if (table.kind === 'unresolved') {
      addError(
        table.sheet,
        table.headerRow,
        'mapping',
        'Choose the table type and map columns, or explicitly exclude its rows.',
      );
      continue;
    }
    if (
      table.headerRow > sheet.rows.length ||
      table.firstRow <= table.headerRow ||
      table.lastRow > sheet.rows.length ||
      table.lastRow < table.firstRow - 1
    ) {
      addError(
        table.sheet,
        table.headerRow,
        'range',
        'Choose a header row and a valid following data range.',
      );
      continue;
    }
    covered.add(rowId(table.sheet, table.headerRow));
    if (
      new Set(Object.values(table.columns)).size !==
      Object.values(table.columns).length
    ) {
      addError(
        table.sheet,
        table.headerRow,
        'columns',
        'A column cannot supply multiple fields in the same table.',
      );
      continue;
    }
    for (let row = table.firstRow; row <= table.lastRow; row++) {
      const cells = sheet.rows[row - 1] ?? [],
        id = rowId(table.sheet, row);
      if (!nonblank(cells) || excluded.has(id)) continue;
      covered.add(id);
      const v: Record<string, string> = { ...table.defaults };
      for (const [field, column] of Object.entries(table.columns))
        v[field] = cells[column]?.trim() ?? '';
      Object.assign(v, overrides.get(id)?.values ?? {});
      const get = (k: string) => v[k]?.trim() ?? '';
      try {
        v.Currency = get('Currency').toUpperCase();
        const symbol = get('Symbol').toUpperCase(),
          type = get('AssetType').toUpperCase();
        if (/^(TOTAL|SUBTOTAL|GRAND TOTAL|TOTAL PORTFOLIO)$/.test(symbol))
          throw new Error(
            'This looks like an aggregate row. Explicitly exclude it instead of importing it as a security.',
          );
        const isCash =
          table.kind === 'cash' ||
          (['positions', 'mixed'].includes(table.kind) &&
            /^(USD|CAD)$/.test(type) &&
            /^CASH$/i.test(get('Description'))) ||
          (table.kind === 'positions' &&
            /^(CASH|CASH BALANCE|CASH & CASH EQUIVALENTS)$/.test(type)) ||
          (table.kind === 'mixed' &&
            (/^(CASH|CASH BALANCE|CASH & CASH EQUIVALENTS)$/.test(type) ||
              /^(CASH(?:\s*\(?[A-Z]{3}\)?)?|(?:USD|CAD)(?:\s+CASH)?)$/.test(
                symbol,
              )));
        if (isCash && !v.Currency) {
          const unit = (/^(USD|CAD)$/.test(type) ? type : symbol).match(
            /\b([A-Z]{3})\b/,
          );
          if (unit && Intl.supportedValuesOf('currency').includes(unit[1]!))
            v.Currency = unit[1]!;
        }
        v.Currency ||= 'USD';
        const key = register(
          get('AccountKey'),
          { ...v, Notes: table.kind === 'accounts' ? get('Notes') : '' },
          table.sheet,
          row,
        );
        if (table.kind === 'accounts') {
          if (sources.some((s) => s.kind === 'account' && s.accountKey === key))
            throw new Error('Duplicate account declaration.');
          sources.push({
            sheet: table.sheet,
            row,
            kind: 'account',
            accountKey: key,
            identity: key,
          });
          continue;
        }
        if (isCash) {
          v.Balance ||= get('Quantity');
          if (!get('Balance'))
            throw new Error(
              'Cash balance is missing. Map its value column or enter an explicit balance, including zero.',
            );
          const cash = cashSchema.parse({
            accountKey: key,
            currency: get('Currency'),
            balance: decimal(get('Balance'), get('Currency')),
          });
          const cashKey = `${key}:${cash.currency}`;
          if (cashKeys.has(cashKey))
            throw new Error(
              'Duplicate cash balance; exclude duplicate/subtotal rows rather than adding them.',
            );
          cashKeys.add(cashKey);
          state.cash.push(cash);
          sources.push({
            sheet: table.sheet,
            row,
            kind: 'cash',
            accountKey: key,
            identity: cash.currency,
          });
          continue;
        }
        const parsed = contract(symbol, get('Description'));
        for (const [field, value] of Object.entries(parsed ?? {})) {
          const supplied =
            field === 'OptionRight'
              ? ({ C: 'CALL', P: 'PUT' }[get(field).toUpperCase()] ??
                get(field))
              : get(field);
          if (
            supplied &&
            supplied.toUpperCase() !== value.toUpperCase() &&
            (field !== 'Strike' || decimal(supplied) !== value)
          )
            throw new Error(
              `Encoded option ${field} conflicts with the supplied field.`,
            );
          v[field] = value;
        }
        const option =
          !!parsed ||
          ['OPTION', 'OPTIONS', 'OPT', 'CALL', 'PUT'].includes(type) ||
          (['OptionRight', 'Expiration', 'Strike'] as const).some(
            (f) =>
              !!get(f) &&
              (table.columns[f] !== undefined ||
                overrides.get(id)?.values[f] !== undefined),
          );
        const shorthand = option
          ? get('Description').match(
              /^(\d+(?:\.\d+)?)(C|P)\s+(\d{1,2})-(\d{1,2})$/i,
            )
          : null;
        const suppliedMonthDay = option
          ? get('Expiration').match(/^(\d{1,2})-(\d{1,2})$/)
          : null;
        if (suppliedMonthDay) {
          v.Expiration = `${currentYear}-${suppliedMonthDay[1]!.padStart(2, '0')}-${suppliedMonthDay[2]!.padStart(2, '0')}`;
          assumptionWarnings.push(
            `${table.sheet} row ${row}: no option expiry year was supplied; used current year ${currentYear} (America/Vancouver), giving ${v.Expiration}. Verify this date before confirming.`,
          );
        }
        if (shorthand) {
          const right = shorthand[2]!.toUpperCase() === 'C' ? 'CALL' : 'PUT';
          if (
            get('Strike') &&
            decimal(get('Strike')) !== decimal(shorthand[1]!)
          )
            throw new Error(
              'Description strike conflicts with the supplied strike.',
            );
          if (
            get('OptionRight') &&
            ![right, shorthand[2]!.toUpperCase()].includes(
              get('OptionRight').toUpperCase(),
            )
          )
            throw new Error(
              'Description option right conflicts with the supplied option right.',
            );
          if (
            get('Expiration') &&
            get('Expiration').slice(5) !==
              `${shorthand[3]!.padStart(2, '0')}-${shorthand[4]!.padStart(2, '0')}`
          )
            throw new Error(
              'Description expiry month/day conflicts with the supplied date.',
            );
          v.Strike = shorthand[1]!;
          v.OptionRight = right;
          v.Underlying ||= symbol;
          if (!get('Expiration')) {
            v.Expiration = `${currentYear}-${shorthand[3]!.padStart(2, '0')}-${shorthand[4]!.padStart(2, '0')}`;
            assumptionWarnings.push(
              `${table.sheet} row ${row}: no option expiry year was supplied; used current year ${currentYear} (America/Vancouver), giving ${v.Expiration}. Verify this date before confirming.`,
            );
          }
        }
        if (['CALL', 'PUT'].includes(type) && !get('OptionRight'))
          v.OptionRight = type;
        const assetType = option
          ? 'OPTION'
          : ['STOCK', 'STOCKS', 'STK', 'EQUITY', 'EQUITIES'].includes(type)
            ? 'STOCK'
            : type;
        const multiplier = option
          ? get('Multiplier')
          : table.columns.Multiplier !== undefined ||
              overrides.get(id)?.values.Multiplier !== undefined
            ? get('Multiplier') || '1'
            : '1';
        for (const field of [
          'Quantity',
          'AssetType',
          'Symbol',
          'Currency',
          ...(option
            ? [
                'Expiration',
                'Multiplier',
                'Deliverable',
                'Underlying',
                'Strike',
                'OptionRight',
              ]
            : []),
        ])
          if (!get(field) && field !== 'Multiplier')
            throw new Error(
              `${field} is missing. Map a column or supply an explicit value.`,
            );
        if (option && !multiplier)
          throw new Error(
            'Multiplier is missing. Confirm the contract size explicitly.',
          );
        let quantity = decimal(get('Quantity'));
        const side = get('Side').toUpperCase();
        if (side) {
          if (!['LONG', 'SHORT'].includes(side))
            throw new Error(
              'Position side must be LONG or SHORT, not a transaction action.',
            );
          if (side === 'LONG' && quantity.startsWith('-'))
            throw new Error('Negative quantity conflicts with LONG side.');
          if (side === 'SHORT' && !quantity.startsWith('-') && quantity !== '0')
            quantity = `-${quantity}`;
        }
        let cost = get('AverageCost');
        if (!cost && get('TotalCost')) {
          if (quantity === '0')
            throw new Error(
              'Cannot infer per-unit cost for zero quantity. Supply AverageCost.',
            );
          const total = decimal(get('TotalCost'), get('Currency'));
          const D = Decimal.clone({
            precision: 60,
            rounding: Decimal.ROUND_HALF_EVEN,
          });
          if (!multiplier)
            throw new Error('Multiplier is required to interpret total cost.');
          cost = new D(total)
            .abs()
            .div(new D(quantity).abs().mul(decimal(multiplier)))
            .toDecimalPlaces(12)
            .toFixed();
        }
        const p = positionSchema.parse({
          accountKey: key,
          instrument: {
            assetType,
            symbol: parsed ? get('Underlying') : symbol,
            exchange: get('Exchange').toUpperCase() || 'UNKNOWN',
            currency: get('Currency'),
            optionRight: option
              ? ({ C: 'CALL', P: 'PUT' }[get('OptionRight').toUpperCase()] ??
                get('OptionRight').toUpperCase())
              : null,
            expiry: option ? get('Expiration') : null,
            strike: option ? decimal(get('Strike')) : null,
            multiplier: decimal(multiplier),
            underlying: option ? get('Underlying').toUpperCase() : null,
            deliverable: option ? get('Deliverable').toUpperCase() : null,
          },
          quantity,
          averageCost: cost ? decimal(cost, get('Currency')) : null,
          quality: cost ? 'BASELINE_ESTIMATE' : 'UNKNOWN',
          ...(get('Description') ? { description: get('Description') } : {}),
          ...(get('OptionGroup') ? { optionGroup: get('OptionGroup') } : {}),
          ...(get('TransactionDate')
            ? { transactionDate: get('TransactionDate') }
            : {}),
          notes: get('Notes'),
        });
        const posKey = `${key}:${instrumentKey(p.instrument)}`;
        if (positionKeys.has(posKey))
          throw new Error(
            'Duplicate account/security row. Exclude duplicates or reconcile quantities explicitly.',
          );
        positionKeys.add(posKey);
        state.positions.push(p);
        sources.push({
          sheet: table.sheet,
          row,
          kind: 'position',
          accountKey: key,
          identity: instrumentKey(p.instrument),
        });
      } catch (e) {
        if (e instanceof z.ZodError)
          for (const issue of e.issues)
            addError(table.sheet, row, issue.path.join('.'), issue.message);
        else
          addError(
            table.sheet,
            row,
            'row',
            e instanceof Error ? e.message : 'Invalid row.',
          );
      }
    }
  }
  for (const clarification of mapping.cashBalances) {
    try {
      const key = [...drafts].find(
        ([k, d]) =>
          k === clarification.account || d.name === clarification.account,
      )?.[0];
      if (!key)
        throw new Error(
          'Cash clarification must reference an account identified in the workbook.',
        );
      const cash = cashSchema.parse({
        accountKey: key,
        currency: clarification.currency,
        balance: decimal(clarification.balance, clarification.currency),
      });
      const identity = `${key}:${cash.currency}`;
      if (cashKeys.has(identity))
        throw new Error(
          'Cash already exists for this account/currency. Correct its source row rather than adding another balance.',
        );
      cashKeys.add(identity);
      state.cash.push(cash);
      drafts.get(key)!.currencies.add(cash.currency);
      sources.push({
        sheet: 'User clarification',
        row: 0,
        kind: 'cash',
        accountKey: key,
        identity: cash.currency,
      });
    } catch (e) {
      addError(
        'User clarification',
        0,
        clarification.account,
        e instanceof Error ? e.message : 'Invalid cash clarification.',
      );
    }
  }
  for (const [key, draft] of drafts) {
    try {
      const d = draft.data;
      const base =
        d.BaseCurrency ||
        (draft.currencies.size === 1 ? [...draft.currencies][0] : 'USD');
      state.accounts.push(
        accountSchema.parse({
          accountKey: key,
          displayName: d.DisplayName,
          institution: d.Institution,
          accountType: d.AccountType?.toUpperCase(),
          baseCurrency: base?.toUpperCase(),
          active: /^(true|yes|1)$/i.test(d.Active ?? '')
            ? true
            : /^(false|no|0)$/i.test(d.Active ?? '')
              ? false
              : d.Active,
          notes: d.Notes,
        }),
      );
    } catch (e) {
      addError(
        'Workbook',
        0,
        `Account ${key}`,
        e instanceof z.ZodError
          ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
          : 'Invalid account metadata.',
      );
    }
  }
  for (const sheet of inspection.sheets)
    sheet.rows.forEach((r, i) => {
      const id = rowId(sheet.name, i + 1);
      if (nonblank(r) && !covered.has(id) && !excluded.has(id))
        addError(
          sheet.name,
          i + 1,
          'unmapped',
          'This row is not mapped. Add a table range or explicitly exclude it with a reason.',
        );
    });
  for (const o of mapping.overrides)
    if (
      !covered.has(rowId(o.sheet, o.row)) ||
      excluded.has(rowId(o.sheet, o.row))
    )
      addError(
        o.sheet,
        o.row,
        'override',
        'Override does not target an included data row.',
      );
  const result = stateSchema.safeParse(state);
  if (!result.success)
    for (const issue of result.error.issues)
      addError('Workbook', 0, issue.path.join('.'), issue.message);
  if (!state.accounts.length)
    addError(
      'Workbook',
      0,
      'accounts',
      'No accounts were identified. A replacement cannot consist solely of ignored rows.',
    );
  return {
    hash,
    state: errors.length ? null : result.success ? result.data : null,
    errors,
    sources,
    warnings: [
      ...assumptionWarnings,
      ...inspection.warnings,
      `${sources.filter((s) => s.kind === 'position').length} position rows and ${sources.filter((s) => s.kind === 'cash').length} cash rows interpreted from reviewed mappings.`,
      `${mapping.excludedRows.length} rows explicitly excluded; verify no holdings or cash are omitted.`,
    ],
  };
}
