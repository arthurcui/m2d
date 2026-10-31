import { expect, it } from 'vitest';
import {
  asksForExplanation,
  explainWorkbookQuestion,
  nextWorkbookQuestion,
  prepareWorkbook,
  workbookDialogueSchema,
  fixtureForInspection,
  groundedMapping,
  interpretationSchema,
} from '../packages/agent/src/index.js';
import { arbitraryWorkbook } from './flexible-fixture.js';

it('reads an explicit account type from a tab label without demanding it again', async () => {
  const prepared = await prepareWorkbook(
    await arbitraryWorkbook('10', '50', 'IKBR RRSP'),
    [],
    '',
    'fixture-v1',
  );
  const output = interpretationSchema.parse(
    (await fixtureForInspection(prepared.inspection, []).generate())
      .structuredOutput,
  );
  const table = output.tables[0]!;
  table.defaults = table.defaults.filter((b) => b.field !== 'AccountType');
  table.defaults.push({
    field: 'AccountType',
    value: 'RRSP',
    source: 'sheet',
    sheet: 'IKBR RRSP',
    row: 0,
    column: 0,
  });
  expect(
    groundedMapping(output, prepared.inspection, '', []).mapping.tables[0]
      ?.defaults.AccountType,
  ).toBe('RRSP');
  table.defaults.at(-1)!.value = 'MARGIN';
  expect(() => groundedMapping(output, prepared.inspection, '', [])).toThrow(
    'account type',
  );
});

it.each([
  'whats AccountType for?',
  'what does RRSP mean',
  'I dont understand',
  'explain deliverable',
  'Is 100 the right multiplier?',
])('keeps follow-up "%s" out of financial evidence', (text) => {
  expect(asksForExplanation(text)).toBe(true);
});
it('accepts direct facts and explains labels without assuming an answer', () => {
  expect(asksForExplanation('all USD')).toBe(false);
  expect(asksForExplanation('IKBR RRSP is RRSP')).toBe(false);
  expect(
    explainWorkbookQuestion('What is AccountType for IKBR RRSP?'),
  ).toContain('not its holdings');
  expect(explainWorkbookQuestion('What is the option multiplier?')).toContain(
    'do not assume 100',
  );
});
it('asks one plain-language question instead of dumping raw validation errors', () => {
  const errors = [
    {
      sheet: 'Questrade RRSP',
      row: 2,
      field: 'row',
      message:
        'Deliverable is missing. Map a column or supply an explicit value.',
    },
    {
      sheet: 'Questrade TFSA',
      row: 3,
      field: 'instrument.assetType',
      message: 'Invalid enum',
    },
  ];
  const question = nextWorkbookQuestion([], errors)!;
  expect(question).toContain('Tab "Questrade RRSP", row 2');
  expect(question).toContain('option deliverable');
  expect(question).not.toMatch(/TFSA|Map a column|enum/);
  expect(
    nextWorkbookQuestion(['First question', 'Second question'], errors),
  ).toBe('First question');
});
it('passes conversation as context separately from supplied facts and enforces bounded input', async () => {
  const dialogue = workbookDialogueSchema.parse({
    message: 'whats AccountType for?',
    question: 'Which account type?',
    history: [{ role: 'assistant', text: 'For example, RRSP.' }],
  });
  const { request } = await prepareWorkbook(
    await arbitraryWorkbook(),
    [],
    'all USD',
    'fixture-v1',
    dialogue,
  );
  const payload = JSON.parse((request.history[0] as { text: string }).text);
  expect(payload.clarification).toBe('all USD');
  expect(payload.dialogue).toEqual(dialogue);
  const schema = request.outputSchema as {
    required: string[];
    properties: Record<string, object>;
  };
  expect(schema.required).toEqual(expect.arrayContaining(['intent', 'reply']));
  expect(schema.properties.intent).not.toHaveProperty('default');
  expect(schema.properties.reply).not.toHaveProperty('default');
  expect(request.instructions).toContain(
    'context ONLY, never financial evidence',
  );
  expect(
    workbookDialogueSchema.safeParse({ ...dialogue, message: 'x'.repeat(4001) })
      .success,
  ).toBe(false);
});
