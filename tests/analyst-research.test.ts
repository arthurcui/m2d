import { it, expect } from 'vitest';
import {
  analystProfile,
  sourcePresets,
  sourceLinkSchema,
} from '../packages/research/dist/index.js';
it('keeps analyst opinions verbatim and never guesses currency, horizon or publisher', () => {
  const result = analystProfile([
    {
      index: 2,
      page: 3,
      text: 'Rating: Buy\nPrice target: $200\nRisks: Demand may weaken.\nThe publisher might be Goldman Sachs.',
    },
  ]);
  expect(result.fields.find((f) => f.field === 'target')!.excerpts).toEqual([
    { text: 'Price target: $200', chunkIndex: 2, page: 3 },
  ]);
  for (const field of [
    'currency',
    'horizon',
    'publisher',
    'analyst',
    'reportDate',
  ])
    expect(result.fields.find((f) => f.field === field)!.excerpts).toEqual([]);
  expect(
    result.fields.find((f) => f.field === 'risks')!.excerpts[0]!.text,
  ).toBe('Risks: Demand may weaken.');
  expect(
    sourceLinkSchema.parse({
      symbol: 'TSLA',
      kind: 'analyst',
      name: 'Public report',
      url: 'https://example.com/report.pdf',
    }).kind,
  ).toBe('analyst');
  expect(
    sourcePresets('TSLA', false).filter((p) => p.kind === 'analyst'),
  ).toHaveLength(2);
});
