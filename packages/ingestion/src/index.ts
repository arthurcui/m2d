import { readTables } from './reader.js';
export { MAX_UPLOAD } from './reader.js';
export * from './flexible.js';
import writeExcel from 'write-excel-file/node';

import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  accountSchema,
  positionSchema,
  cashSchema,
  stateSchema,
  type State,
  emptyState,
  PortfolioError,
} from '@m2d/portfolio';

import { MAX_UPLOAD } from './reader.js';
export const headers = {
  Accounts: [
    'AccountKey',
    'DisplayName',
    'Institution',
    'AccountType',
    'BaseCurrency',
    'Active',
    'Notes',
  ],
  Positions: [
    'AccountKey',
    'AssetType',
    'Symbol',
    'Exchange',
    'Currency',
    'Quantity',
    'AverageCost',
    'OptionRight',
    'Expiration',
    'Strike',
    'Multiplier',
    'Underlying',
    'Deliverable',
    'Notes',
  ],
  Cash: ['AccountKey', 'Currency', 'Balance'],
} as const;
export type RowError = {
  sheet: string;
  row: number;
  field: string;
  message: string;
};
export type ImportResult = {
  hash: string;
  state: State | null;
  errors: RowError[];
};
export async function parseWorkbook(bytes: Buffer): Promise<ImportResult> {
  if (bytes.length > MAX_UPLOAD)
    throw new PortfolioError(
      'UPLOAD_TOO_LARGE',
      'Workbook limit is 2 MiB.',
      413,
    );
  const hash = createHash('sha256').update(bytes).digest('hex');
  const errors: RowError[] = [];
  const state = emptyState();
  const sourceRows: Record<'Accounts' | 'Positions' | 'Cash', number[]> = {
    Accounts: [],
    Positions: [],
    Cash: [],
  };
  try {
    const loaded = await readTables(bytes);
    const sheets = loaded.sheets.map((s) => ({ sheet: s.name, data: s.rows }));
    if (sheets.length !== 3 || new Set(sheets.map((s) => s.sheet)).size !== 3)
      throw new Error(
        'Use exactly Accounts, Positions and Cash sheets; supply effective time in the upload form.',
      );
    let rowCount = 0;
    for (const name of ['Accounts', 'Positions', 'Cash'] as const) {
      const sheet = sheets.find((s) => s.sheet === name);
      if (!sheet) throw new Error(`Missing required sheet ${name}.`);
      const head = sheet.data[0] ?? [];
      if (
        JSON.stringify(head) !== JSON.stringify(headers[name]) &&
        !(
          (name === 'Positions' &&
            JSON.stringify(head) ===
              JSON.stringify([
                ...headers.Positions,
                'Description',
                'OptionGroup',
              ])) ||
          (name === 'Positions' &&
            JSON.stringify(head) ===
              JSON.stringify([
                ...headers.Positions,
                'Description',
                'OptionGroup',
                'TransactionDate',
              ]))
        )
      ) {
        errors.push({
          sheet: name,
          row: 1,
          field: 'headers',
          message: `Expected columns: ${headers[name].join(', ')}`,
        });
        continue;
      }
      for (let idx = 1; idx < sheet.data.length; idx++) {
        const values = sheet.data[idx]!;
        if (values.every((v) => v === null || v === '')) continue;
        if (++rowCount > 2200)
          throw new Error('Workbook has more than 2200 data rows.');
        const row = Object.fromEntries(
          head.map((key, i) => [key, values[i] ?? null]),
        );
        const str = (key: string) => {
          const v = row[key];
          return v == null ? '' : String(v);
        };
        const nullable = (key: string) => str(key) || null;
        try {
          if (values.length > head.length)
            throw new Error('Unexpected extra cells.');
          if (name === 'Accounts')
            state.accounts.push(
              accountSchema.parse({
                accountKey: str('AccountKey'),
                displayName: str('DisplayName'),
                institution: str('Institution'),
                accountType: str('AccountType'),
                baseCurrency: str('BaseCurrency'),
                active:
                  str('Active').toUpperCase() === 'TRUE'
                    ? true
                    : str('Active').toUpperCase() === 'FALSE'
                      ? false
                      : row.Active,
                notes: str('Notes'),
              }),
            );
          if (name === 'Positions')
            state.positions.push(
              positionSchema.parse({
                accountKey: str('AccountKey'),
                instrument: {
                  assetType: str('AssetType'),
                  symbol: str('Symbol'),
                  exchange: str('Exchange'),
                  currency: str('Currency'),
                  optionRight: nullable('OptionRight'),
                  expiry: nullable('Expiration'),
                  strike: nullable('Strike'),
                  multiplier: str('Multiplier'),
                  underlying: nullable('Underlying'),
                  deliverable: nullable('Deliverable'),
                },
                quantity: str('Quantity'),
                averageCost: str('AverageCost') || null,
                ...(str('TransactionDate')
                  ? { transactionDate: str('TransactionDate') }
                  : {}),
                ...(str('Description')
                  ? { description: str('Description') }
                  : {}),
                ...(str('OptionGroup')
                  ? { optionGroup: str('OptionGroup') }
                  : {}),
                quality: str('AverageCost') ? 'BASELINE_ESTIMATE' : 'UNKNOWN',
                notes: str('Notes'),
              }),
            );
          if (name === 'Cash')
            state.cash.push(
              cashSchema.parse({
                accountKey: str('AccountKey'),
                currency: str('Currency'),
                balance: str('Balance'),
              }),
            );
          sourceRows[name].push(idx + 1);
        } catch (e) {
          if (e instanceof z.ZodError)
            for (const issue of e.issues)
              errors.push({
                sheet: name,
                row: idx + 1,
                field: issue.path.join('.'),
                message: issue.message,
              });
          else
            errors.push({
              sheet: name,
              row: idx + 1,
              field: 'row',
              message: e instanceof Error ? e.message : 'Invalid row.',
            });
        }
      }
    }
    // Cross-row errors retain the offending worksheet and row, rather than silently merging.
    for (const [name, rows, keys] of [
      ['Accounts', state.accounts, state.accounts.map((a) => a.accountKey)],
      [
        'Positions',
        state.positions,
        state.positions.map(
          (p) => `${p.accountKey}|${JSON.stringify(p.instrument)}`,
        ),
      ],
      [
        'Cash',
        state.cash,
        state.cash.map((c) => `${c.accountKey}|${c.currency}`),
      ],
    ] as const) {
      const seen = new Set<string>();
      rows.forEach((row, i) => {
        if (seen.has(keys[i]!))
          errors.push({
            sheet: name,
            row: sourceRows[name][i]!,
            field: 'key',
            message: 'Duplicate row identity.',
          });
        seen.add(keys[i]!);
        if (
          name !== 'Accounts' &&
          !state.accounts.some((a) => a.accountKey === row.accountKey)
        )
          errors.push({
            sheet: name,
            row: sourceRows[name][i]!,
            field: 'AccountKey',
            message: 'Unknown account.',
          });
      });
    }
    const validated = stateSchema.safeParse(state);
    if (!validated.success)
      for (const issue of validated.error.issues)
        errors.push({
          sheet: 'Workbook',
          row: 0,
          field: issue.path.join('.'),
          message: issue.message,
        });
    if (state.accounts.length === 0)
      errors.push({
        sheet: 'Accounts',
        row: 2,
        field: 'AccountKey',
        message:
          'At least one account is required. To close all accounts, include explicit inactive zero-balance rows.',
      });
  } catch (e) {
    errors.push({
      sheet: 'Workbook',
      row: 0,
      field: 'file',
      message: e instanceof Error ? e.message : 'Invalid XLSX workbook.',
    });
  }
  return { hash, state: errors.length ? null : state, errors };
}
export function sevenAccountFixture(): State {
  return stateSchema.parse({
    accounts: Array.from({ length: 7 }, (_, n) => ({
      accountKey: `DEMO${n + 1}`,
      displayName: `Example account ${n + 1}`,
      institution: 'Fixture only',
      accountType: n % 2 ? 'TFSA' : 'CASH',
      baseCurrency: n % 2 ? 'CAD' : 'USD',
      active: true,
      notes: 'Fictional; do not import into a real workspace.',
    })),
    positions: Array.from({ length: 7 }, (_, n) => ({
      accountKey: `DEMO${n + 1}`,
      instrument: {
        assetType: 'STOCK',
        symbol: 'AAPL',
        exchange: 'NASDAQ',
        currency: 'USD',
        optionRight: null,
        expiry: null,
        strike: null,
        multiplier: '1',
        underlying: null,
        deliverable: null,
      },
      quantity: '100',
      averageCost: '150',
      quality: 'BASELINE_ESTIMATE',
      notes: '',
    })),
    cash: Array.from({ length: 7 }, (_, n) => ({
      accountKey: `DEMO${n + 1}`,
      currency: n % 2 ? 'CAD' : 'USD',
      balance: '10000',
    })),
  });
}
export async function workbook(state: State = emptyState()): Promise<Buffer> {
  const rows = {
    Accounts: state.accounts.map((a) => [
      a.accountKey,
      a.displayName,
      a.institution,
      a.accountType,
      a.baseCurrency,
      a.active ? 'TRUE' : 'FALSE',
      a.notes,
    ]),
    Positions: state.positions.map((p) => [
      p.accountKey,
      p.instrument.assetType,
      p.instrument.symbol,
      p.instrument.exchange,
      p.instrument.currency,
      p.quantity,
      p.averageCost,
      p.instrument.optionRight ?? '',
      p.instrument.expiry ?? '',
      p.instrument.strike ?? '',
      p.instrument.multiplier,
      p.instrument.underlying ?? '',
      p.instrument.deliverable ?? '',
      p.notes,
      p.description ?? '',
      p.optionGroup ?? '',
      p.transactionDate ?? '',
    ]),
    Cash: state.cash.map((c) => [c.accountKey, c.currency, c.balance]),
  };
  return writeExcel(
    (['Accounts', 'Positions', 'Cash'] as const).map((name) => ({
      sheet: name,
      data: [
        name === 'Positions'
          ? [...headers[name], 'Description', 'OptionGroup', 'TransactionDate']
          : [...headers[name]],
        ...rows[name],
      ].map((row) =>
        row.map((value) => ({ type: String, value: value ?? '' })),
      ),
    })),
  ).toBuffer();
}
