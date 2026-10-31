import { it, expect } from 'vitest';
import writeExcel from 'write-excel-file/node';
import {
  inspectWorkbook,
  resolveWorkbook,
  parseWorkbook,
  workbook,
} from '../packages/ingestion/src/index.js';
import {
  learnImportMemory,
  recallImportMemory,
} from '../packages/agent/src/index.js';
import { arbitraryWorkbook } from './flexible-fixture.js';
const make = (rows: string[][]) =>
  writeExcel(
    rows.map((r) => r.map((value) => ({ type: String, value }))),
    { sheet: 'Broker Account 1' },
  ).toBuffer();
it('accepts required holding columns, optional basis/description and USD default with cash quantity', async () => {
  const bytes = await make([
    [
      'Asset class',
      'Equity symbol',
      'Quantity',
      'Description',
      'Cost base per unit',
    ],
    ['ETF', 'SPY', '2', 'S&P fund', ''],
    ['CASH', 'CASH', '120.25', '', ''],
  ]);
  const inspection = await inspectWorkbook(bytes),
    result = await resolveWorkbook(bytes, inspection.mapping);
  expect(result.errors).toEqual([]);
  expect(result.state?.positions[0]).toMatchObject({
    averageCost: null,
    quality: 'UNKNOWN',
    description: 'S&P fund',
    quantity: '2',
    instrument: { assetType: 'ETF', currency: 'USD', exchange: 'UNKNOWN' },
  });
  expect(result.state?.cash[0]?.balance).toBe('120.25');
  const missing = await make([
    ['Equity symbol', 'Quantity'],
    ['AAPL', '2'],
    ['CASH', '100'],
  ]);
  expect(
    (
      await resolveWorkbook(missing, (await inspectWorkbook(missing)).mapping)
    ).errors.some((e) => e.message.includes('AssetType')),
  ).toBe(true);
});
it('supports explicit other currencies and independent grouped option legs', async () => {
  const bytes = await make([
    [
      'Asset class',
      'Equity symbol',
      'Quantity',
      'Currency',
      'Option group',
      'Multiplier',
      'Deliverable',
    ],
    [
      'OPTION',
      'AAPL  261218C00200000',
      '1',
      'USD',
      'Call spread',
      '100',
      'STANDARD',
    ],
    [
      'OPTION',
      'AAPL  261218C00210000',
      '-1',
      'USD',
      'Call spread',
      '100',
      'STANDARD',
    ],
    ['CASH', 'CASH', '500', 'USD', '', '', ''],
    ['CASH', 'CASH', '70', 'EUR', '', '', ''],
  ]);
  const result = await resolveWorkbook(
    bytes,
    (await inspectWorkbook(bytes)).mapping,
  );
  expect(result.errors).toEqual([]);
  expect(
    result.state?.positions.map((p) => [
      p.quantity,
      p.optionGroup,
      p.averageCost,
    ]),
  ).toEqual([
    ['1', 'Call spread', null],
    ['-1', 'Call spread', null],
  ]);
  expect(result.state?.cash[1]).toMatchObject({
    currency: 'EUR',
    balance: '70',
  });
  const roundTrip = await parseWorkbook(await workbook(result.state!));
  expect(roundTrip.errors).toEqual([]);
  expect(roundTrip.state?.positions).toEqual(result.state?.positions);
});
it('reuses confirmed layout rules with fresh financial values and rejects changed identity/layout/corrections', async () => {
  const first = await inspectWorkbook(await arbitraryWorkbook());
  const memory = learnImportMemory(first, first.mapping)!;
  expect(memory).not.toBeNull();
  const bytes = await arbitraryWorkbook('203', '987.65'),
    next = await inspectWorkbook(bytes),
    mapping = recallImportMemory(memory, next)!;
  expect(mapping).not.toBeNull();
  const result = await resolveWorkbook(bytes, mapping);
  expect(result.state?.positions[0]?.quantity).toBe('203');
  expect(result.state?.cash[0]?.balance).toBe('987.65');
  next.sheets[0]!.rows[1]![0] = 'Different heading';
  expect(recallImportMemory(memory, next)).toBeNull();
  const altered = structuredClone(first);
  altered.sheets[0]!.name = 'Different broker account';
  expect(recallImportMemory(memory, altered)).toBeNull();
  first.mapping.overrides.push({
    sheet: 'Retirement',
    row: 3,
    values: { Quantity: '999' },
    reason: 'Correction',
  });
  expect(learnImportMemory(first, first.mapping)).toBeNull();
  first.mapping.overrides = [];
  first.mapping.tables[0]!.defaults.AverageCost = '100';
  expect(learnImportMemory(first, first.mapping)).toBeNull();
});
