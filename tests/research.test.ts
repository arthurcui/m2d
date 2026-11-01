import { expect, it } from 'vitest';
import {
  chunks,
  FixtureResearchProvider,
  SecResearchProvider,
  xbrlFacts,
} from '../packages/research/dist/index.js';
import {
  validateResearchCitations,
  researchScopeHistory,
} from '../packages/agent/src/research-citations.js';
import { randomUUID } from 'node:crypto';
it('extracts safe HTML passages, rejects empty text and preserves synthetic source provenance', async () => {
  const fixture = await new FixtureResearchProvider().fetch('DEMO');
  expect(fixture.sources).toHaveLength(2);
  expect((await chunks(fixture.sources[0]!))[0]?.text).toContain('SYNTHETIC');
  const source = {
    ...fixture.sources[0]!,
    mime: 'text/html' as const,
    raw: Buffer.from(
      '<h1>Outlook</h1><p>Revenue &amp; risks</p><script>alert(1)</script>',
    ),
  };
  const text = (await chunks(source))[0]!.text;
  expect(text).toContain('Revenue & risks');
  expect(text).not.toContain('alert');
  await expect(
    chunks({ ...source, mime: 'text/plain', raw: Buffer.from('') }),
  ).rejects.toMatchObject({ code: 'NO_TEXT' });
});
it('preserves XBRL precision, units, periods, accessions and revisions without aggregating them', () => {
  const source =
    '{"facts":{"us-gaap":{"Revenues":{"units":{"USD":[{"start":"2026-01-01","end":"2026-03-31","val":9007199254740993,"accn":"old","filed":"2026-05-01"},{"start":"2026-01-01","end":"2026-03-31","val":9007199254740994,"accn":"amended","filed":"2026-06-01"}]}}}}}';
  const facts = xbrlFacts(source);
  expect(facts.map((f) => f.value)).toEqual([
    '9007199254740993',
    '9007199254740994',
  ]);
  expect(facts[0]).toMatchObject({
    unit: 'USD',
    start: '2026-01-01',
    end: '2026-03-31',
    accession: 'old',
  });
});
it('requires SEC identification and never falls back to fixture', async () => {
  const p = new SecResearchProvider('');
  expect(p.configured).toBe(false);
  await expect(p.fetch('TSLA')).rejects.toMatchObject({
    code: 'SEC_IDENTITY_REQUIRED',
  });
});
it('imports SEC metadata, two reports and raw XBRL through fixed hosts with no redirects', async () => {
  const urls: string[] = [];
  const p = new SecResearchProvider(
    'M2D dev@example.com',
    async (url, init) => {
      urls.push(String(url));
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toMatchObject({
        'User-Agent': 'M2D dev@example.com',
      });
      const body = String(url).includes('company_tickers')
        ? JSON.stringify({
            0: { cik_str: 123, ticker: 'DEMO', title: 'Demo Inc' },
          })
        : String(url).includes('/submissions/')
          ? JSON.stringify({
              filings: {
                recent: {
                  accessionNumber: [
                    '0000000123-26-000002',
                    '0000000123-26-000001',
                  ],
                  form: ['10-Q', '10-K'],
                  primaryDocument: ['q.htm', 'k.htm'],
                  acceptanceDateTime: [
                    '2026-08-01T20:00:00Z',
                    '2026-02-01T20:00:00Z',
                  ],
                  filingDate: ['2026-08-01', '2026-02-01'],
                },
              },
            })
          : String(url).includes('companyfacts')
            ? '{"facts":{}}'
            : '<p>Management expects revenue growth. Risks include customer concentration.</p>';
      return new Response(body);
    },
  );
  const r = await p.fetch('DEMO');
  expect(r.cik).toBe('0000000123');
  expect(r.sources.filter((s) => s.form !== 'INDEX')).toHaveLength(2);
  expect(urls).toHaveLength(5);
  expect(urls.every((u) => /^https:\/\/(data|www)\.sec\.gov\//.test(u))).toBe(
    true,
  );
});
it('blocks invented research citation IDs', () => {
  const id = randomUUID();
  expect(() =>
    validateResearchCitations(`[Invented](/research?document=${id})`, []),
  ).toThrow('not retrieved');
  expect(() =>
    validateResearchCitations(`[Source](/research?document=${id}#chunk-0)`, [
      {
        id: randomUUID(),
        kind: 'tool_call',
        callId: 'c',
        name: 'research_search_documents_v1',
        arguments: {},
      },
      {
        id: randomUUID(),
        kind: 'tool_result',
        callId: 'c',
        output: [
          {
            id,
            hash: 'a'.repeat(64),
            available_at: '2026-01-01T00:00:00Z',
            provider: 'fixture',
            chunk_index: 0,
            text: 'Revenue declined.',
          },
        ],
      },
    ]),
  ).not.toThrow();
});
it('parses a real text PDF in an isolated worker and rejects invalid PDFs', async () => {
  const source = (await new FixtureResearchProvider().fetch('PDF')).sources[0]!;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream =
    'BT /F1 12 Tf 30 350 Td (Revenue outlook improved. Customer concentration remains a risk.) Tj ET';
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  const parsed = await chunks({
    ...source,
    mime: 'application/pdf',
    raw: Buffer.from(pdf),
  });
  expect(parsed[0]).toMatchObject({ page: 1 });
  expect(parsed[0]?.text).toContain('Revenue outlook improved');
  await expect(
    chunks({
      ...source,
      mime: 'application/pdf',
      raw: Buffer.from('not a PDF'),
    }),
  ).rejects.toMatchObject({ code: 'INVALID_PDF' });
});

it('does not replay later evidence or answers when changing the historical boundary', () => {
  const at = '2026-01-01T00:00:00Z';
  const history = [
    {
      id: '1',
      kind: 'text' as const,
      role: 'user' as const,
      text: 'Research context: DEMO.\nCurrent question',
    },
    {
      id: '2',
      kind: 'text' as const,
      role: 'assistant' as const,
      text: 'Later evidence',
    },
    {
      id: '3',
      kind: 'text' as const,
      role: 'user' as const,
      text: `Research context: DEMO; evidence available by ${at}.\nOld view`,
    },
    {
      id: '4',
      kind: 'text' as const,
      role: 'assistant' as const,
      text: 'Historical answer',
    },
    {
      id: '5',
      kind: 'text' as const,
      role: 'user' as const,
      text: `Research context: DEMO; evidence available by ${at}.\nFollow up`,
    },
  ];
  expect(researchScopeHistory(history, at).map((i) => i.id)).toEqual([
    '3',
    '4',
    '5',
  ]);
  expect(history).toHaveLength(5);
});

it('validates exact passages, comparisons, facts, missing citations and current-turn scope', () => {
  const id = randomUUID(),
    other = randomUUID();
  const history: import('../packages/llm/src/index.js').CanonicalItem[] = [
    { id: randomUUID(), kind: 'text', role: 'user', text: 'Review revenue' },
    {
      id: randomUUID(),
      kind: 'tool_call',
      callId: 'r',
      name: 'research_search_evidence_v2',
      arguments: {},
    },
    {
      id: randomUUID(),
      kind: 'tool_result',
      callId: 'r',
      output: {
        hits: [
          {
            document_id: id,
            provider: 'sec',
            chunk_index: 2,
            text: 'Revenue declined.',
          },
        ],
      },
    },
  ];
  for (const target of [
    `${id}#chunk-0`,
    `${id}#chunk-999999`,
    `${id}#chunk-2oops`,
    `${other}#chunk-2`,
  ])
    expect(() =>
      validateResearchCitations(
        `[source](/research?document=${target})`,
        history,
      ),
    ).toThrow('not retrieved');
  expect(() =>
    validateResearchCitations(
      `[source](/research?document=${id}#chunk-2)`,
      history,
    ),
  ).not.toThrow();
  expect(() => validateResearchCitations('Revenue rose 25%.', history)).toThrow(
    'did not cite',
  );
  expect(() =>
    validateResearchCitations(
      'NO_SIGNAL: evidence does not establish the requested claim.',
      history,
    ),
  ).not.toThrow();
  expect(() =>
    validateResearchCitations('I will read the next passage.', history, false),
  ).not.toThrow();
  expect(() =>
    validateResearchCitations('Hello!', [
      ...history,
      { id: randomUUID(), kind: 'text', role: 'user', text: 'hello' },
    ]),
  ).not.toThrow();
  history[2] = {
    id: randomUUID(),
    kind: 'tool_result',
    callId: 'r',
    output: {
      before: { id, hash: 'abc', available_at: '2026-01-01' },
      after: { id: other, hash: 'def', available_at: '2026-01-02' },
      removed: [{ index: 3, text: 'Old guidance' }],
      added: [{ index: 5, text: 'New guidance' }],
    },
  };
  expect(() =>
    validateResearchCitations(
      `[old](/research?document=${id}#chunk-3) [new](/research?document=${other}#chunk-5)`,
      history,
    ),
  ).not.toThrow();
  expect(() =>
    validateResearchCitations(
      `[wrong](/research?document=${id}#chunk-5)`,
      history,
    ),
  ).toThrow();
  history[2] = {
    id: randomUUID(),
    kind: 'tool_result',
    callId: 'r',
    output: {
      facts: [{ document_id: id, provider: 'sec', value: '123', unit: 'USD' }],
    },
  };
  expect(() =>
    validateResearchCitations(`[facts](/research?document=${id})`, history),
  ).not.toThrow();
  expect(() =>
    validateResearchCitations(
      `[facts](/research?document=${id}#chunk-0)`,
      history,
    ),
  ).toThrow();
});
