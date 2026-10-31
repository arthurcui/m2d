import { expect, it } from 'vitest';
import writeExcel from 'write-excel-file/node';
import {
  prepareWorkbook,
  fixtureForInspection,
  interpretationSchema,
  validateInterpretation,
  groundedMapping,
  workbookRowReply,
  nextWorkbookQuestion,
} from '../packages/agent/src/index.js';

it('owns account identity and ignores invented active defaults and free-worded expiry questions', async () => {
  const prepared = await prepareWorkbook(await sample(), [], '', 'fixture-v1');
  const output = interpretationSchema.parse(
    (await fixtureForInspection(prepared.inspection, []).generate())
      .structuredOutput,
  );
  const table = output.tables[0]!;
  table.defaults = table.defaults.filter(
    (b) => !['AccountKey', 'DisplayName', 'Active'].includes(b.field),
  );
  for (const field of ['AccountKey', 'DisplayName', 'Active'] as const)
    table.defaults.push({
      field,
      value: 'invented',
      source: 'classification',
      sheet: table.sheet,
      row: 0,
      column: 0,
    });
  output.questions = [
    'For the Demo RRSP option on ABC (row 2), what is the expiry year for 12.50C 10-30?',
    'Tab "Demo RRSP": I could not validate active.',
  ];
  const result = groundedMapping(output, prepared.inspection, '', []);
  expect(result.questions).toEqual([]);
  expect(result.mapping.tables[0]!.defaults.AccountKey).toBe(
    prepared.inspection.mapping.tables[0]!.defaults.AccountKey,
  );
  expect(result.mapping.tables[0]!.defaults.DisplayName).toBe('Demo RRSP');
  expect(result.mapping.tables[0]!.defaults.Active).toBeUndefined();
});

it('answers row-location questions using original cells without guessing a missing row', async () => {
  const { inspection } = await prepareWorkbook(
    await sample(),
    [],
    '',
    'fixture-v1',
  );
  expect(
    nextWorkbookQuestion(
      [],
      [
        {
          sheet: 'Demo RRSP',
          row: 2,
          field: 'Deliverable',
          message: 'Missing',
        },
      ],
      inspection,
    ),
  ).toContain('Source: "ABC" — "12.50C 10-30"');
  expect(
    workbookRowReply('Tab "Demo RRSP", row 2: what is the expiry?', inspection),
  ).toContain('column 1 = "ABC"');
  expect(
    workbookRowReply('Tab "Demo RRSP", row 2: what is the expiry?', inspection),
  ).toContain('12.50C 10-30');
  expect(
    workbookRowReply('Tab "Demo RRSP": what is active?', inspection),
  ).toContain('did not identify an exact worksheet row');
});

async function sample() {
  return writeExcel([
    {
      sheet: 'Demo RRSP',
      data: [
        [
          'Equity Symbol',
          'Equity Description',
          'Asset Class',
          'Quantity',
          'Cost Per Share',
        ],
        ['ABC', '12.50C 10-30', 'OPT', '-2', '0.5'],
        ['XYZ', '', 'STK', '4', '25'],
        ['-', 'CASH', 'USD', '1234.0', ''],
      ].map((row) => row.map((value) => ({ type: String, value }))),
    },
  ]).toBuffer();
}
it('accepts equivalent numeric spelling while rejecting a different financial value', async () => {
  const prepared = await prepareWorkbook(await sample(), [], '', 'fixture-v1');
  const output = interpretationSchema.parse(
    (await fixtureForInspection(prepared.inspection, []).generate())
      .structuredOutput,
  );
  output.tables[0]!.defaults.push({
    field: 'Multiplier',
    value: '12.5',
    source: 'clarification',
    sheet: 'Demo RRSP',
    row: 2,
    column: 0,
  });
  output.tables[0]!.defaults.push({
    field: 'Quantity',
    value: '-2.00',
    source: 'cell',
    sheet: 'Demo RRSP',
    row: 2,
    column: 3,
  });
  expect(() =>
    groundedMapping(output, prepared.inspection, 'multiplier $12.50', []),
  ).not.toThrow();
  expect(() =>
    groundedMapping(output, prepared.inspection, 'multiplier $12.51', []),
  ).toThrow();
});
it('reads ordinary broker labels and source cash; only missing option terms remain unresolved', async () => {
  const bytes = await sample();
  const prepared = await prepareWorkbook(bytes, [], '', 'fixture-v1');
  const response = await fixtureForInspection(
    prepared.inspection,
    [],
  ).generate();
  const output = interpretationSchema.parse(response.structuredOutput);
  output.questions = ['Tab "Demo RRSP", row 4: what is the asset class?'];
  output.cashBalances.push({
    account: {
      field: 'AccountKey',
      value: 'Demo_RRSP',
      source: 'sheet',
      sheet: 'Demo RRSP',
      row: 0,
      column: 0,
    },
    currency: {
      field: 'Currency',
      value: 'USD',
      source: 'cell',
      sheet: 'Demo RRSP',
      row: 4,
      column: 2,
    },
    balance: {
      field: 'Balance',
      value: '1234',
      source: 'cell',
      sheet: 'Demo RRSP',
      row: 4,
      column: 3,
    },
    reason: 'Explicit cash row',
  });
  const first = await validateInterpretation(
    { ...response, structuredOutput: output },
    bytes,
    prepared.inspection,
    '',
    [],
  );
  expect(first.questions).toEqual([]);
  expect(first.errors).toHaveLength(1);
  expect(first.errors[0]?.message).toContain('Deliverable');
  expect(first.warnings.some((w) => w.includes('no option expiry year'))).toBe(
    true,
  );
  expect(first.sources.some((s) => s.kind === 'cash')).toBe(true);
  const clarification =
    'Demo RRSP row 2 expires 2026-10-30; Multiplier 100; Deliverable STANDARD';
  output.overrides.push({
    sheet: 'Demo RRSP',
    row: 2,
    reason: 'User supplied missing contract terms',
    values: [
      {
        field: 'Expiration',
        value: '2026-10-30',
        source: 'clarification',
        sheet: 'Demo RRSP',
        row: 2,
        column: 0,
      },
      {
        field: 'Multiplier',
        value: '100',
        source: 'clarification',
        sheet: 'Demo RRSP',
        row: 2,
        column: 0,
      },
      {
        field: 'Deliverable',
        value: 'STANDARD',
        source: 'clarification',
        sheet: 'Demo RRSP',
        row: 2,
        column: 0,
      },
    ],
  });
  const result = await validateInterpretation(
    { ...response, structuredOutput: output },
    bytes,
    prepared.inspection,
    clarification,
    [],
  );
  expect(result.errors).toEqual([]);
  expect(result.state?.cash).toHaveLength(1);
  expect(result.state?.cash[0]?.balance).toBe('1234');
  expect(result.state?.positions[0]).toMatchObject({
    quantity: '-2',
    instrument: {
      assetType: 'OPTION',
      optionRight: 'CALL',
      strike: '12.5',
      underlying: 'ABC',
    },
  });
  expect(result.state?.positions[1]?.instrument.assetType).toBe('STOCK');
});

it('normalizes per-row defaults, equivalent duplicates, and model-invented expiry citations', async () => {
  const bytes = await sample();
  const { inspection } = await prepareWorkbook(bytes, [], '', 'fixture-v1');
  const response = await fixtureForInspection(inspection, []).generate();
  const output = interpretationSchema.parse(response.structuredOutput);
  for (const [row, value] of [
    [2, 'OPTION'],
    [3, 'STOCK'],
    [4, 'CASH'],
  ] as const)
    output.tables[0]!.defaults.push({
      field: 'AssetType',
      value,
      source: 'classification',
      sheet: 'Demo RRSP',
      row,
      column: 2,
    });
  for (const [field, value] of [
    ['Multiplier', '100'],
    ['Multiplier', '100.0'],
    ['Deliverable', 'STANDARD'],
    ['Expiration', '2026-10-30'],
  ] as const)
    output.tables[0]!.defaults.push({
      field,
      value,
      source: 'clarification',
      sheet: 'Demo RRSP',
      row: 2,
      column: 0,
    });
  const result = await validateInterpretation(
    { ...response, structuredOutput: output },
    bytes,
    inspection,
    '100 STANDARD',
    [],
  );
  expect(result.errors).toEqual([]);
  expect(result.state).not.toBeNull();
  expect(result.state!.positions.map((p) => p.instrument.assetType)).toEqual([
    'OPTION',
    'STOCK',
  ]);
  expect(result.warnings.join(' ')).toContain('no option expiry year');
  const conflict = structuredClone(output);
  conflict.tables[0]!.defaults.push({
    field: 'Multiplier',
    value: '200',
    source: 'clarification',
    sheet: 'Demo RRSP',
    row: 2,
    column: 0,
  });
  expect(() =>
    groundedMapping(conflict, inspection, '100 200 STANDARD', []),
  ).toThrow('Conflicting model assignments');
});

it('restores an omitted recognized source table without overriding explicit exclusions', async () => {
  const { inspection } = await prepareWorkbook(
    await sample(),
    [],
    '',
    'fixture-v1',
  );
  const output = interpretationSchema.parse(
    (await fixtureForInspection(inspection, []).generate()).structuredOutput,
  );
  output.tables = [];
  expect(
    groundedMapping(output, inspection, '', []).mapping.tables,
  ).toHaveLength(1);
  output.excludedRows = [
    { sheet: 'Demo RRSP', row: 2, reason: 'Review this exclusion' },
  ];
  expect(
    groundedMapping(output, inspection, '', []).mapping.tables,
  ).toHaveLength(0);
  inspection.sheets[0]!.rows[1] = [];
  const restored = groundedMapping(output, inspection, '', []).mapping;
  expect(restored.tables).toHaveLength(1);
  expect(restored.excludedRows).toEqual(output.excludedRows);
});
