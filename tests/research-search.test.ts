import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  evidenceSearchSchema,
  rankEvidence,
  type SearchPassage,
} from '../packages/research/dist/index.js';
const passage = (
  text: string,
  doc = randomUUID(),
  index = 0,
): SearchPassage => ({
  document_id: doc,
  chunk_index: index,
  text,
  page: 2,
  symbol: 'DEMO',
  title: 'Quarterly report',
  form: '10-Q',
  provider: 'upload',
  revision: 1,
  url: null,
  published_at: null,
  available_at: '2026-10-01T00:00:00.000Z',
  hash: 'a'.repeat(64),
});
it('fuses independent lexical and semantic rankings without treating scores as probabilities', () => {
  const exact = passage('Revenue is 123.450000000000000001 USD.'),
    meaning = passage('Existing liquidity supports six months of operations.');
  const hits = rankEvidence(
    [exact, meaning],
    [
      { ...meaning, similarity: 0.7 },
      { ...exact, similarity: 0.5 },
    ],
  );
  expect(hits).toHaveLength(2);
  expect(hits[0]?.matches).toEqual(['keyword', 'semantic']);
  expect(hits.find((h) => h.document_id === exact.document_id)?.text).toContain(
    '123.450000000000000001',
  );
  expect(hits[0]?.citation).toContain('#chunk-');
  expect(hits[0]!.score).toBeLessThan(1);
});
it('deduplicates repeated passages and gives different documents a place before overflow', () => {
  const doc = randomUUID(),
    rows = Array.from({ length: 6 }, (_, i) =>
      passage(`Evidence item ${i}`, doc, i),
    );
  const other = passage('Another source reports a different risk.');
  const hits = rankEvidence(
    [...rows, other, passage(rows[0]!.text.toUpperCase())],
    [],
    5,
  );
  expect(hits).toHaveLength(5);
  expect(hits[3]?.document_id).toBe(other.document_id);
  expect(
    hits.filter((h) => h.text.toLowerCase() === rows[0]!.text.toLowerCase()),
  ).toHaveLength(1);
});
it('bounds public/Advisor search contracts and rejects reversed date filters', () => {
  expect(
    evidenceSearchSchema.safeParse({
      symbol: 'TSLA',
      query: 'risk',
      limit: 1000,
    }).success,
  ).toBe(false);
  expect(
    evidenceSearchSchema.safeParse({
      symbol: 'TSLA',
      query: 'risk',
      publishedFrom: '2026-10-31',
      publishedTo: '2026-01-01',
    }).success,
  ).toBe(false);
  expect(
    evidenceSearchSchema.parse({
      symbol: 'tsla',
      query: ' liquidity ',
      forms: ['10-q'],
    }).forms,
  ).toEqual(['10-Q']);
});
