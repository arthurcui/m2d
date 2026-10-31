import { it, expect } from 'vitest';
import writeExcel from 'write-excel-file/node';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import {
  inspectWorkbook,
  resolveWorkbook,
  parseWorkbook,
} from '../packages/ingestion/src/index.js';
import { arbitraryWorkbook } from './flexible-fixture.js';
const make = (data: string[][], sheet = 'Broker RRSP') =>
  writeExcel(
    data.map((r) => r.map((value) => ({ type: String, value }))),
    { sheet },
  ).toBuffer();
it('detects reordered headers, title rows, differently named tabs, mixed cash, decimal formatting and sources', async () => {
  const bytes = await arbitraryWorkbook(),
    inspection = await inspectWorkbook(bytes);
  expect(inspection.mapping.tables).toHaveLength(2);
  expect(inspection.mapping.tables[0]?.headerRow).toBe(2);
  expect(inspection.mapping.excludedRows).toEqual([
    {
      sheet: 'Retirement',
      row: 1,
      reason: 'Detected title/preamble — review before excluding',
    },
  ]);
  const result = await resolveWorkbook(bytes, inspection.mapping);
  expect(result.errors).toEqual([]);
  expect(result.state?.accounts.map((a) => a.accountKey)).toEqual([
    'Retirement',
    'Savings',
  ]);
  expect(result.state?.positions.map((p) => p.instrument.assetType)).toEqual([
    'STOCK',
    'ETF',
  ]);
  expect(result.state?.cash.map((c) => c.balance)).toEqual([
    '12345.67',
    '-123.45',
  ]);
  expect(result.sources[0]).toMatchObject({
    sheet: 'Retirement',
    row: 3,
    kind: 'position',
  });
});
it('blocks unknown sheets and row gaps until explicitly excluded, with reasons', async () => {
  const bytes = await make([
    ['Unfamiliar title'],
    ['Something', 'Else'],
    ['secret data', '42'],
  ]);
  const inspection = await inspectWorkbook(bytes);
  expect(inspection.mapping.tables[0]?.kind).toBe('unresolved');
  expect((await resolveWorkbook(bytes, inspection.mapping)).state).toBeNull();
  const valid = await arbitraryWorkbook(),
    plan = (await inspectWorkbook(valid)).mapping;
  plan.excludedRows = [];
  const failed = await resolveWorkbook(valid, plan);
  expect(
    failed.errors.some(
      (e) => e.sheet === 'Retirement' && e.row === 1 && e.field === 'unmapped',
    ),
  ).toBe(true);
});
it('supports row corrections and missing details without editing the original workbook', async () => {
  const bytes = await make([
    ['Security', 'Qty', 'Unit Cost', 'Cash Balance', 'CCY'],
    ['AAPL', '10', '123.50', '', 'USD'],
    ['CASH', '', '', '0', 'USD'],
  ]);
  const inspection = await inspectWorkbook(bytes),
    table = inspection.mapping.tables[0]!;
  table.columns.Symbol = 0;
  table.defaults.AssetType = 'STOCK';
  table.defaults.Exchange = 'NASDAQ';
  const result = await resolveWorkbook(bytes, inspection.mapping);
  expect(result.errors).toEqual([]);
  expect(result.state?.positions[0]?.instrument.symbol).toBe('AAPL');
  inspection.mapping.overrides.push({
    sheet: 'Broker RRSP',
    row: 2,
    values: { Quantity: '12' },
    reason: 'Verified against statement',
  });
  const edited = await resolveWorkbook(bytes, inspection.mapping);
  expect(edited.state?.positions[0]?.quantity).toBe('12');
  expect(result.state?.positions[0]?.quantity).toBe('10');
});
it('does not treat market value, price or buying power as cost basis/cash', async () => {
  const bytes = await make([
    ['Ticker', 'Quantity', 'Price', 'Market Value', 'Buying Power', 'Currency'],
    ['AAPL', '10', '150', '1500', '10000', 'USD'],
  ]);
  const inspection = await inspectWorkbook(bytes);
  expect(inspection.mapping.tables[0]?.columns.AverageCost).toBeUndefined();
  expect(inspection.mapping.tables[0]?.columns.Balance).toBeUndefined();
  const result = await resolveWorkbook(bytes, inspection.mapping);
  expect(result.state).toBeNull();
  expect(result.errors.some((e) => e.message.includes('cash'))).toBe(true);
});
it('decodes explicit OCC terms, preserves short signs and requires verified standard deliverables', async () => {
  const bytes = await make([
    [
      'Ticker',
      'Qty',
      'Average Cost',
      'Currency',
      'Exchange',
      'Cash Balance',
      'Position Side',
    ],
    ['AAPL  261218C00200000', '2', '3', 'USD', 'NASDAQ', '', 'SHORT'],
    ['CASH', '', '', 'USD', '', '5000', ''],
  ]);
  const inspection = await inspectWorkbook(bytes);
  inspection.mapping.tables.forEach((t) => {
    if (t.kind === 'mixed' || t.kind === 'positions')
      t.defaults.AssetType = 'OPTION';
  });
  expect(
    (await resolveWorkbook(bytes, inspection.mapping)).errors.some(
      (e) =>
        e.message.includes('Deliverable') || e.message.includes('Multiplier'),
    ),
  ).toBe(true);
  Object.assign(inspection.mapping.tables[0]!.defaults, {
    Multiplier: '100',
    Deliverable: 'STANDARD',
  });
  const result = await resolveWorkbook(bytes, inspection.mapping);
  expect(result.errors).toEqual([]);
  expect(result.state?.positions[0]).toMatchObject({
    quantity: '-2',
    instrument: {
      symbol: 'AAPL',
      expiry: '2026-12-18',
      strike: '200',
      optionRight: 'CALL',
      multiplier: '100',
    },
  });
  inspection.mapping.overrides.push({
    sheet: 'Broker RRSP',
    row: 2,
    values: { Strike: '201' },
    reason: 'Conflicting test',
  });
  expect(
    (await resolveWorkbook(bytes, inspection.mapping)).errors.some((e) =>
      e.message.includes('conflicts'),
    ),
  ).toBe(true);
});
it('converts explicitly mapped total book cost using decimal arithmetic and contract size', async () => {
  const bytes = await make([
    ['Ticker', 'Shares', 'Book Value', 'Currency', 'Exchange', 'Cash Amount'],
    ['AAPL', '3', '100.00', 'USD', 'NASDAQ', ''],
    ['CASH', '', '', 'USD', '', '0'],
  ]);
  const inspection = await inspectWorkbook(bytes);
  inspection.mapping.tables.forEach((t) => {
    if (t.kind === 'mixed' || t.kind === 'positions')
      t.defaults.AssetType = 'STOCK';
  });
  const result = await resolveWorkbook(bytes, inspection.mapping);
  expect(result.errors).toEqual([]);
  expect(result.state?.positions[0]?.averageCost).toBe('33.333333333333');
});
it('supports cash currency columns and multiple tables on a tab', async () => {
  const bytes = await make(
    [
      ['Account', 'USD', 'CAD'],
      ['RRSP', '500', '700'],
      ['Ticker', 'Quantity', 'Average Cost', 'Currency', 'Exchange'],
      ['AAPL', '2', '100', 'USD', 'NASDAQ'],
    ],
    'Combined',
  );
  const inspection = await inspectWorkbook(bytes);
  inspection.mapping.tables.forEach((t) => {
    if (t.kind === 'mixed' || t.kind === 'positions')
      t.defaults.AssetType = 'STOCK';
  });
  expect(inspection.mapping.tables).toHaveLength(3);
  for (const table of inspection.mapping.tables) {
    table.defaults.BaseCurrency = 'USD';
    table.defaults.AccountKey = 'RRSP';
    table.defaults.DisplayName = 'RRSP';
  }
  const result = await resolveWorkbook(bytes, inspection.mapping);
  expect(result.errors).toEqual([]);
  expect(result.state?.cash.map((c) => c.balance)).toEqual(['500', '700']);
  expect(result.state?.positions).toHaveLength(1);
});
it('rejects duplicate positions and unreviewed aggregate rows', async () => {
  const bytes = await make([
    ['Ticker', 'Qty', 'Average Cost', 'Currency', 'Exchange', 'Cash Balance'],
    ['AAPL', '2', '100', 'USD', 'NASDAQ', ''],
    ['AAPL', '2', '100', 'USD', 'NASDAQ', ''],
    ['Total', '4', '100', 'USD', 'NASDAQ', ''],
    ['CASH', '', '', 'USD', '', '500'],
  ]);
  const inspection = await inspectWorkbook(bytes);
  inspection.mapping.tables.forEach((t) => {
    if (t.kind === 'mixed' || t.kind === 'positions')
      t.defaults.AssetType = 'STOCK';
  });
  const result = await resolveWorkbook(bytes, inspection.mapping);
  expect(
    result.errors.some((e) => e.row === 3 && e.message.includes('Duplicate')),
  ).toBe(true);
  expect(
    result.errors.some((e) => e.row === 4 && e.message.includes('aggregate')),
  ).toBe(true);
  inspection.mapping.excludedRows.push(
    { sheet: 'Broker RRSP', row: 3, reason: 'Duplicate display' },
    { sheet: 'Broker RRSP', row: 4, reason: 'Subtotal' },
  );
  expect((await resolveWorkbook(bytes, inspection.mapping)).errors).toEqual([]);
});
it('accepts saved formula results only with visible warnings; rejects unevaluated formulas', async () => {
  const entries = unzipSync(await arbitraryWorkbook()),
    path = 'xl/worksheets/sheet1.xml';
  let xml = strFromU8(entries[path]!);
  xml = xml.replace(
    /<c\b[^>]*r="B3"[^>]*>[\s\S]*?<\/c>/,
    '<c r="B3"><f>50+50</f><v>100</v></c>',
  );
  entries[path] = strToU8(xml);
  const bytes = Buffer.from(zipSync(entries));
  const inspection = await inspectWorkbook(bytes);
  expect(inspection.warnings.join(' ')).toContain('formula');
  expect(
    (await resolveWorkbook(bytes, inspection.mapping)).state?.positions[0]
      ?.quantity,
  ).toBe('100');
  expect((await parseWorkbook(bytes)).state).toBeNull();
  entries[path] = strToU8(
    xml.replace('<f>50+50</f><v>100</v>', '<f>50+50</f>'),
  );
  await expect(inspectWorkbook(Buffer.from(zipSync(entries)))).rejects.toThrow(
    'no saved value',
  );
});
it('does not guess conflicting currency or ambiguous numeric/date conventions', async () => {
  const bytes = await make([
    ['Ticker', 'Qty', 'Average Cost', 'Currency', 'Exchange', 'Cash Balance'],
    ['AAPL', '2', '1,23', 'USD', 'NASDAQ', ''],
    ['CASH', '', '', 'USD', '', 'CAD 500'],
  ]);
  const inspection = await inspectWorkbook(bytes);
  inspection.mapping.tables.forEach((t) => {
    if (t.kind === 'mixed' || t.kind === 'positions')
      t.defaults.AssetType = 'STOCK';
  });
  const result = await resolveWorkbook(bytes, inspection.mapping);
  expect(result.state).toBeNull();
  expect(result.errors.some((e) => e.message.includes('separators'))).toBe(
    true,
  );
  expect(result.errors.some((e) => e.message.includes('differs'))).toBe(true);
});
it('requires explicit user cash clarification when a workbook omits cash entirely', async () => {
  const bytes = await make([
    ['Ticker', 'Quantity', 'Average Cost', 'Currency', 'Exchange'],
    ['AAPL', '10', '100', 'USD', 'NASDAQ'],
  ]);
  const inspection = await inspectWorkbook(bytes);
  inspection.mapping.tables.forEach((t) => {
    if (t.kind === 'mixed' || t.kind === 'positions')
      t.defaults.AssetType = 'STOCK';
  });
  expect((await resolveWorkbook(bytes, inspection.mapping)).state).toBeNull();
  inspection.mapping.cashBalances.push({
    account: 'Broker_RRSP',
    currency: 'USD',
    balance: '0',
    reason: 'Confirmed no uninvested cash on statement',
  });
  const result = await resolveWorkbook(bytes, inspection.mapping);
  expect(result.errors).toEqual([]);
  expect(result.state?.cash[0]?.balance).toBe('0');
  expect(result.sources.at(-1)).toMatchObject({
    sheet: 'User clarification',
    row: 0,
    kind: 'cash',
  });
});
it('does not invent an account from a cash total row', async () => {
  const bytes = await make(
    [
      ['Account', 'Currency', 'Balance'],
      ['My account', 'USD', '500'],
      ['Total', 'USD', '500'],
    ],
    'Balances',
  );
  const inspection = await inspectWorkbook(bytes);
  const result = await resolveWorkbook(bytes, inspection.mapping);
  expect(result.state).toBeNull();
  expect(
    result.errors.some((e) => e.row === 3 && e.message.includes('aggregate')),
  ).toBe(true);
  inspection.mapping.excludedRows.push({
    sheet: 'Balances',
    row: 3,
    reason: 'Combined account total',
  });
  expect((await resolveWorkbook(bytes, inspection.mapping)).errors).toEqual([]);
});
