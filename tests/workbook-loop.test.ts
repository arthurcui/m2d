import { expect, it } from 'vitest';
import {
  scopedAnswer,
  clarificationEvidence,
  explicitDate,
  repeatedQuestion,
  prepareWorkbook,
  interpretationSchema,
  fixtureForInspection,
  groundedMapping,
  validateInterpretation,
} from '../packages/agent/src/index.js';
import { arbitraryWorkbook } from './flexible-fixture.js';

it('retains row context without copying Advisor examples into evidence', () => {
  const facts = scopedAnswer(
    'Tab "IKBR Margin", row 6: what is the asset class? For example ETF.',
    'CASH',
  );
  expect(clarificationEvidence(facts, 'IKBR Margin', 6)).toBe('CASH');
  expect(clarificationEvidence(facts, 'IKBR RRSP', 5)).toBe('');
  expect(facts).not.toContain('ETF');
  expect(
    scopedAnswer(
      'Tab "IKBR Margin": what is the account currency?',
      'all accounts are usd',
    ),
  ).toBe('all accounts are usd');
  expect(
    repeatedQuestion(
      'Tab "IKBR Margin", row 6: what is the asset class?',
      facts,
    ),
  ).toBe(true);
});

it('normalizes only explicit unambiguous dates and rejects invalid calendar dates', () => {
  expect(explicitDate('expiry oct 30, 2026')).toBe('2026-10-30');
  expect(explicitDate('expiration 2026-10-30')).toBe('2026-10-30');
  expect(explicitDate('02/03/26')).toBeUndefined();
  expect(explicitDate('Feb 30, 2026')).toBeUndefined();
});

it('uses an explicit currency answer when the model incorrectly cites the tab name', async () => {
  const prepared = await prepareWorkbook(
    await arbitraryWorkbook(),
    [],
    '',
    'fixture-v1',
  );
  const output = interpretationSchema.parse(
    (await fixtureForInspection(prepared.inspection, []).generate())
      .structuredOutput,
  );
  output.overrides.push({
    sheet: 'Retirement',
    row: 3,
    reason: 'Holding currency',
    values: [
      {
        field: 'Currency',
        value: 'USD',
        source: 'sheet',
        sheet: 'Retirement',
        row: 3,
        column: 0,
      },
    ],
  });
  expect(() =>
    groundedMapping(output, prepared.inspection, 'all accounts are usd', []),
  ).not.toThrow();
  expect(() =>
    groundedMapping(
      output,
      prepared.inspection,
      scopedAnswer('Tab "Savings", row 3: what is the currency?', 'USD'),
      [],
    ),
  ).toThrow('currency');
});

it('keeps a corrected cash row as cash across regenerated mappings without demanding a ticker', async () => {
  const bytes = await arbitraryWorkbook();
  const prepared = await prepareWorkbook(bytes, [], '', 'fixture-v1');
  const response = await fixtureForInspection(
    prepared.inspection,
    [],
  ).generate();
  const output = interpretationSchema.parse(response.structuredOutput);
  output.tables[0]!.kind = 'positions';
  output.overrides.push({
    sheet: 'Retirement',
    row: 4,
    values: [
      {
        field: 'AssetType',
        value: 'STOCK',
        source: 'classification',
        sheet: 'Retirement',
        row: 4,
        column: 5,
      },
      {
        field: 'Symbol',
        value: 'invented cash ticker',
        source: 'classification',
        sheet: 'Retirement',
        row: 4,
        column: 0,
      },
    ],
    reason: 'Bad model interpretation',
  });
  output.tables[0]!.defaults.push({
    field: 'BaseCurrency',
    value: 'USD',
    source: 'classification',
    sheet: 'Retirement',
    row: 0,
    column: 0,
  });
  const facts = scopedAnswer(
    'Tab "Retirement", row 4: what is the asset class?',
    'its cash',
  );
  const result = await validateInterpretation(
    { ...response, structuredOutput: output },
    bytes,
    prepared.inspection,
    facts,
    [],
  );
  expect(result.errors).toEqual([]);
  expect(
    result.state?.cash.find((c) => c.accountKey === 'Retirement')?.balance,
  ).toBe('12345.67');
  expect(result.state?.positions).toHaveLength(2);
});

it('grounds a normalized expiration in the original natural-language answer, never another row', async () => {
  const prepared = await prepareWorkbook(
    await arbitraryWorkbook(),
    [],
    '',
    'fixture-v1',
  );
  const output = interpretationSchema.parse(
    (await fixtureForInspection(prepared.inspection, []).generate())
      .structuredOutput,
  );
  output.overrides.push({
    sheet: 'Retirement',
    row: 3,
    reason: 'Explicit expiry',
    values: [
      {
        field: 'Expiration',
        value: '2026-10-30',
        source: 'clarification',
        sheet: 'Retirement',
        row: 3,
        column: 0,
      },
    ],
  });
  const facts = scopedAnswer(
    'Tab "Retirement", row 3: is this a standard option?',
    'its a tsll covered call short at $11.30 expiry oct 30, 2026',
  );
  expect(() =>
    groundedMapping(output, prepared.inspection, facts, []),
  ).not.toThrow();
  output.overrides[0]!.values[0]!.sheet = 'Savings';
  expect(() => groundedMapping(output, prepared.inspection, facts, [])).toThrow(
    'expiration',
  );
});
