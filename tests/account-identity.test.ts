import { expect, it } from 'vitest';
import {
  accountBindings,
  bindAccountMapping,
  fixtureForInspection,
  validateInterpretation,
} from '../packages/agent/src/index.js';
import {
  inspectWorkbook,
  resolveWorkbook,
  workbook,
  parseWorkbook,
} from '../packages/ingestion/src/index.js';
import {
  accountSchema,
  positionSchema,
} from '../packages/portfolio/src/index.js';
import { arbitraryWorkbook } from './flexible-fixture.js';
it('does not guess between identically named accounts at different brokers', async () => {
  const inspection = await inspectWorkbook(
    await arbitraryWorkbook('1', '1', 'Margin'),
  );
  const a = accountSchema.parse({
    accountKey: 'A',
    displayName: 'Margin',
    institution: 'Broker A',
    accountType: 'MARGIN',
    baseCurrency: 'USD',
    active: true,
  });
  const b = { ...a, accountKey: 'B', institution: 'Broker B' };
  const identity = accountBindings(
    inspection,
    [a, b],
    [],
    [
      { sheet: 'Margin', kind: 'rename', accountKey: 'B' },
      { sheet: 'Savings', kind: 'new' },
    ],
  );
  expect(accountBindings(inspection, [a, b], [], []).pending).toContain(
    'Margin',
  );
  inspection.mapping.tables[0]!.defaults.Institution = 'Broker A';
  const mapping = bindAccountMapping(inspection.mapping, identity.bindings, [
    { sheet: 'Margin', kind: 'rename', accountKey: 'B' },
    { sheet: 'Savings', kind: 'new' },
  ]);
  expect(mapping.tables[0]!.defaults.Institution).toBe('Broker B');
  expect(mapping.tables[0]!.defaults.AccountKey).toBe('B');
});
it('requires a choice for a new tab and preserves stable identity on rename', async () => {
  const bytes = await arbitraryWorkbook('100', '1000', 'Rebranded Retirement'),
    inspection = await inspectWorkbook(bytes);
  const accounts = [
    accountSchema.parse({
      accountKey: 'OLD',
      displayName: 'Old retirement',
      institution: '',
      accountType: 'OTHER',
      baseCurrency: 'USD',
      active: true,
    }),
    accountSchema.parse({
      accountKey: 'Savings',
      displayName: 'Savings',
      institution: '',
      accountType: 'OTHER',
      baseCurrency: 'CAD',
      active: true,
    }),
  ];
  expect(accountBindings(inspection, accounts, [], []).pending).toEqual([
    'Rebranded Retirement',
  ]);
  const choices = [
    {
      sheet: 'Rebranded Retirement',
      kind: 'rename' as const,
      accountKey: 'OLD',
    },
  ];
  const identity = accountBindings(inspection, accounts, [], choices);
  const mapping = bindAccountMapping(
    inspection.mapping,
    identity.bindings,
    choices,
  );
  const result = await resolveWorkbook(bytes, mapping, accounts);
  expect(result.errors).toEqual([]);
  expect(
    result.state?.accounts.find((a) => a.accountKey === 'OLD')?.displayName,
  ).toBe('Rebranded Retirement');
  expect(result.state?.positions[0]?.accountKey).toBe('OLD');
  expect(
    accountBindings(
      inspection,
      accounts,
      [{ sheetName: 'Rebranded Retirement', accountKey: 'OLD' }],
      [],
    ).pending,
  ).toEqual([]);
  expect(() =>
    accountBindings(
      inspection,
      accounts,
      [],
      [
        {
          sheet: 'Rebranded Retirement',
          kind: 'rename',
          accountKey: 'missing',
        },
      ],
    ),
  ).toThrow('Choose an existing');
  inspection.mapping = mapping;
  const interpreted = await validateInterpretation(
    await fixtureForInspection(inspection, accounts).generate(),
    bytes,
    inspection,
    '',
    accounts,
  );
  expect(interpreted.errors).toEqual([]);
});
it('keeps optional transaction dates through workbook round trips and rejects invalid dates', async () => {
  const bytes = await arbitraryWorkbook(),
    inspection = await inspectWorkbook(bytes),
    result = await resolveWorkbook(bytes, inspection.mapping);
  const state = result.state!;
  state.positions[0]!.transactionDate = '2026-10-30';
  expect(
    positionSchema.safeParse({
      ...state.positions[0],
      transactionDate: '2026-02-30',
    }).success,
  ).toBe(false);
  expect(
    positionSchema.safeParse({
      ...state.positions[0],
      transactionDate: '10/11/2026',
    }).success,
  ).toBe(false);
  const roundTrip = await parseWorkbook(await workbook(state));
  expect(roundTrip.errors).toEqual([]);
  expect(roundTrip.state?.positions[0]?.transactionDate).toBe('2026-10-30');
  expect(roundTrip.state?.positions[1]?.transactionDate).toBeUndefined();
});
