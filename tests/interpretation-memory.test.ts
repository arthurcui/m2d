import { expect, it } from 'vitest';
import {
  inspectWorkbook,
  resolveWorkbook,
} from '../packages/ingestion/src/index.js';
import {
  learnImportMemory,
  recallImportMemory,
  fixtureForInspection,
  validateInterpretation,
} from '../packages/agent/src/index.js';
import { interpretationWorkbook } from './interpretation-fixture.js';

async function learned() {
  const bytes = await interpretationWorkbook();
  const inspection = await inspectWorkbook(bytes);
  inspection.mapping.overrides = [
    {
      sheet: 'Rules RRSP',
      row: 2,
      values: { AssetType: 'STOCK' },
      reason: 'Confirmed classification correction',
    },
    {
      sheet: 'Rules RRSP',
      row: 3,
      values: {
        Multiplier: '100',
        Deliverable: 'STANDARD',
        Expiration: '2026-10-30',
      },
      reason: 'Confirmed contract details',
    },
  ];
  const memory = learnImportMemory(inspection, inspection.mapping)!;
  return { bytes, inspection, memory };
}
it('remembers classifications and contract terms by source values, not row number or financial amounts', async () => {
  const { memory } = await learned();
  expect(memory.version).toBe(2);
  expect(memory.rules).toHaveLength(3);
  expect(memory.mapping.overrides).toEqual([]);
  expect(JSON.stringify(memory)).not.toMatch(/4123\.45|17\.25|2026-10-30/);
  const bytes = await interpretationWorkbook('99', '7654.32', '28.50', true);
  const inspection = await inspectWorkbook(bytes);
  const mapping = recallImportMemory(memory, inspection)!;
  expect(mapping.overrides.find((o) => o.row === 3)?.values.AssetType).toBe(
    'STOCK',
  );
  expect(mapping.overrides.find((o) => o.row === 2)?.values.Multiplier).toBe(
    '100',
  );
  const result = await resolveWorkbook(
    bytes,
    mapping,
    [],
    new Date('2027-01-01T09:00:00Z'),
  );
  expect(result.errors).toEqual([]);
  expect(
    result.state?.positions.find((p) => p.instrument.symbol === 'AAA'),
  ).toMatchObject({ quantity: '99', averageCost: '28.5' });
  expect(result.state?.cash[0]?.balance).toBe('7654.32');
  expect(result.state?.positions[0]?.instrument.expiry).toBe('2027-10-30');
});
it('keeps earlier rule versions and rejects changed contracts, headers and invalid profiles', async () => {
  const { memory, inspection } = await learned();
  inspection.mapping.overrides[0]!.values.AssetType = 'ETF';
  const updated = learnImportMemory(inspection, inspection.mapping, memory)!;
  expect(memory.rules?.find((r) => r.field === 'AssetType')?.value).toBe(
    'STOCK',
  );
  expect(updated.rules?.find((r) => r.field === 'AssetType')?.value).toBe(
    'ETF',
  );
  const changed = await inspectWorkbook(
    await interpretationWorkbook('8', '100', '20', false, '13C 11-27'),
  );
  const mapping = recallImportMemory(memory, changed)!;
  expect(mapping.overrides.some((o) => o.values.Multiplier)).toBe(false);
  changed.sheets[0]!.rows[0]![0] = 'Different meaning';
  expect(recallImportMemory(memory, changed)).toBeNull();
  expect(
    recallImportMemory(
      {
        ...memory,
        rules: [{ ...memory.rules![0], field: 'Quantity', value: '999' }],
      },
      inspection,
    ),
  ).toBeNull();
  const fresh = await inspectWorkbook(await interpretationWorkbook());
  const malicious = structuredClone(memory);
  malicious.mapping.tables[0]!.defaults.Balance = '999';
  expect(recallImportMemory(malicious, fresh)).toBeNull();
});
it('keeps confirmed rules available on the model interpretation path', async () => {
  const { memory } = await learned();
  const bytes = await interpretationWorkbook('12', '500', '21');
  const inspection = await inspectWorkbook(bytes);
  inspection.mapping = recallImportMemory(memory, inspection)!;
  const response = await fixtureForInspection(inspection, []).generate();
  const result = await validateInterpretation(
    response,
    bytes,
    inspection,
    '',
    [],
  );
  expect(result.errors).toEqual([]);
  expect(result.state?.positions[0]?.instrument.assetType).toBe('STOCK');
  expect(result.state?.positions[1]?.instrument.multiplier).toBe('100');
});
it('defaults expiry to the Vancouver current year, preserves explicit years and rejects impossible dates', async () => {
  const { bytes, inspection } = await learned();
  delete inspection.mapping.overrides[1]!.values.Expiration;
  const boundary = await resolveWorkbook(
    bytes,
    inspection.mapping,
    [],
    new Date('2027-01-01T01:00:00Z'),
  );
  expect(boundary.state?.positions[1]?.instrument.expiry).toBe('2026-10-30');
  expect(boundary.warnings.join(' ')).toContain(
    'current year 2026 (America/Vancouver)',
  );
  inspection.mapping.overrides[1]!.values.Expiration = '2029-10-30';
  const explicit = await resolveWorkbook(
    bytes,
    inspection.mapping,
    [],
    new Date('2026-10-31T12:00:00Z'),
  );
  expect(explicit.state?.positions[1]?.instrument.expiry).toBe('2029-10-30');
  expect(explicit.warnings.join(' ')).not.toContain('no option expiry year');
  delete inspection.mapping.overrides[1]!.values.Expiration;
  const invalid = await interpretationWorkbook(
    '7',
    '100',
    '20',
    false,
    '12.50C 02-30',
  );
  expect(
    (
      await resolveWorkbook(
        invalid,
        inspection.mapping,
        [],
        new Date('2026-10-31T12:00:00Z'),
      )
    ).state,
  ).toBeNull();
});
