import { z } from 'zod';
import type { WorkbookInspection } from '@m2d/portfolio';

export const isInternalWorkbookQuestion = (question: string) =>
  /\b(account\s*key|active)\b|AI assigned (?:a column )?field more than once|AI assigned a field more than once|AI output did not pass validation|Conflicting model assignments/i.test(
    question,
  );

export function workbookQuestionLocation(
  question: string,
  inspection: WorkbookInspection,
) {
  const matches = inspection.sheets.filter((s) => question.includes(s.name));
  const quoted = question.match(/(?:tab|sheet)\s+"([^"]+)"/i)?.[1];
  const sheet = quoted
    ? inspection.sheets.find((s) => s.name === quoted)
    : matches.length === 1
      ? matches[0]
      : undefined;
  return { sheet, row: Number(question.match(/\brow\s+(\d+)/i)?.[1] ?? 0) };
}

export function workbookRowReply(
  question: string,
  inspection: WorkbookInspection,
) {
  const { sheet, row } = workbookQuestionLocation(question, inspection);
  const cells = row > 0 ? sheet?.rows[row - 1] : undefined;
  if (!sheet || !cells)
    return 'That question did not identify an exact worksheet row. I cannot honestly name a holding from it. Use Retry interpretation so I can locate the source; no portfolio changes have been made.';
  return `Tab "${sheet.name}", row ${row}: ${cells
    .map((value, column) =>
      value.trim() ? `column ${column + 1} = ${JSON.stringify(value)}` : '',
    )
    .filter(Boolean)
    .join('; ')}. These are the original workbook cells, not inferred values.`;
}

export const workbookDialogueSchema = z
  .object({
    message: z.string().min(1).max(4000),
    question: z.string().max(2000),
    explain: z.boolean().default(false),
    history: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            text: z.string().max(4000),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict();
export type WorkbookDialogue = z.infer<typeof workbookDialogueSchema>;

const answerSchema = z
  .object({
    sheet: z.string(),
    row: z.number().int().nonnegative(),
    field: z.string(),
    answer: z.string(),
  })
  .strict();
export function scopedAnswer(question: string, answer: string) {
  // Keep source identity, never copy example values from an Advisor question.
  const location = question.match(/(?:Tab|tab) "([^"]+)"(?:,? row (\d+))?/);
  if (
    !location ||
    /^all\b|\ball\s+(?:accounts|tabs|holdings|positions)\b/i.test(answer)
  )
    return answer;
  const field =
    Object.entries(fields).find(([key, value]) =>
      new RegExp(`${key}|${value.label}`, 'i').test(question),
    )?.[0] ?? '';
  return JSON.stringify({
    sheet: location[1],
    row: Number(location[2] ?? 0),
    field,
    answer,
  });
}
export function scopedAnswers(clarification: string) {
  return clarification.split('\n').flatMap((line) => {
    try {
      const parsed = answerSchema.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}
export function clarificationEvidence(
  clarification: string,
  sheet: string,
  row: number,
) {
  const scoped = scopedAnswers(clarification);
  const globals = clarification.split('\n').filter((line) => {
    try {
      return !answerSchema.safeParse(JSON.parse(line)).success;
    } catch {
      return true;
    }
  });
  return [
    ...globals,
    ...scoped
      .filter((a) => a.sheet === sheet && (a.row === 0 || a.row === row))
      .map((a) => a.answer),
  ].join('\n');
}

export function explicitDate(text: string): string | undefined {
  const months = [
    'jan',
    'feb',
    'mar',
    'apr',
    'may',
    'jun',
    'jul',
    'aug',
    'sep',
    'oct',
    'nov',
    'dec',
  ];
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  const named = text.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})\b/i,
  );
  const value =
    iso?.[0] ??
    (named
      ? `${named[3]}-${String(months.indexOf(named[1]!.slice(0, 3).toLowerCase()) + 1).padStart(2, '0')}-${named[2]!.padStart(2, '0')}`
      : undefined);
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
    ? value
    : undefined;
}

export function answeredValue(field: string, text: string) {
  if (/\b(not|maybe|perhaps|unsure|guess)\b/i.test(text)) return undefined;
  if (field === 'AssetType') {
    if (/^cash\s+(?:in\s+)?(?:usd|cad)[.!]?$/i.test(text.trim())) return 'CASH';
    if (/^(?:it'?s\s+|its\s+)?cash[.!]?$/i.test(text.trim())) return 'CASH';
    if (
      /^(?:(?:it'?s|its)\s+(?:clearly\s+saying\s+)?)?(?:stock|stocks|equity|equities)[.!]?$/i.test(
        text.trim(),
      )
    )
      return 'STOCK';
    if (/^(?:it'?s\s+|its\s+)?(?:an?\s+)?options?[.!]?$/i.test(text.trim()))
      return 'OPTION';
    if (/^etfs?[.!]?$/i.test(text.trim())) return 'ETF';
  }
  if (field === 'Multiplier')
    return text.trim().match(/^(?:multiplier\s+)?(\d+(?:\.\d+)?)$/i)?.[1];
  if (
    field === 'Deliverable' &&
    /^(?:deliverable\s+)?STANDARD$/i.test(text.trim())
  )
    return 'STANDARD';
  if (field === 'Currency' || field === 'BaseCurrency') {
    const codes = [...new Set(text.toUpperCase().match(/\b(?:USD|CAD)\b/g))];
    if (codes.length === 1) return codes[0];
  }
  if (field === 'Expiration' || field === 'TransactionDate')
    return explicitDate(text);
  return undefined;
}

export function repeatedQuestion(
  question: string | undefined,
  clarification: string,
) {
  if (!question) return false;
  const location = scopedAnswers(scopedAnswer(question, ''))[0];
  return (
    !!location &&
    scopedAnswers(clarification).some(
      (answer) =>
        answer.sheet === location.sheet &&
        answer.row === location.row &&
        answer.field === location.field &&
        answeredValue(answer.field, answer.answer) !== undefined,
    )
  );
}
export const repeatedQuestionReply =
  'I could not apply an answer you already supplied. Your answer is saved for this import; you do not need to repeat it. Select Retry interpretation, or correct the source row and upload again. Nothing has been changed in your portfolio.';

// Questions are never evidence for a financial value, even if a model tries
// to interpret them as an answer. The model also handles less explicit intent.
export function asksForExplanation(message: string) {
  return /\?|^(what|whats|what's|why|how|which|where|when|can you|could you|would you|please explain|explain|help|i (don't|dont|do not) (understand|know)|not sure)\b/i.test(
    message.trim(),
  );
}

const fields: Record<string, { label: string; help: string; example: string }> =
  {
    AccountType: {
      label: 'account type',
      help: 'Account type describes the account, not its holdings: CASH, MARGIN, RRSP, TFSA, or OTHER. It is used to label your account; it does not connect to your broker.',
      example: 'RRSP',
    },
    BaseCurrency: {
      label: 'account currency',
      help: 'Account currency is the currency used to label the account. USD is the default; specify CAD if that is correct. Cash balances remain in their own currencies.',
      example: 'USD',
    },
    Currency: {
      label: 'currency',
      help: 'Currency identifies the currency of this holding or cash balance. USD is the default; CAD is also supported.',
      example: 'USD',
    },
    AssetType: {
      label: 'asset class',
      help: 'Asset class describes what the row holds: STOCK, ETF, OPTION, or CASH for a cash row.',
      example: 'ETF',
    },
    Multiplier: {
      label: 'option multiplier',
      help: 'The multiplier is the number of underlying units represented by one option contract. Check the contract details; do not assume 100 for an adjusted contract.',
      example: 'Multiplier 100 (only if your contract confirms it)',
    },
    Deliverable: {
      label: 'option deliverable',
      help: 'The deliverable describes what is exchanged on exercise. STANDARD means the standard underlying shares; adjusted contracts may differ. Check the broker contract details before answering.',
      example: 'Deliverable STANDARD (only if verified)',
    },
    Quantity: {
      label: 'quantity',
      help: 'Quantity is the number of shares or option contracts. Short positions use a negative quantity.',
      example: 'Quantity -2',
    },
    Balance: {
      label: 'cash balance',
      help: 'Cash balance is actual cash, not buying power or market value. State the amount and its currency, including zero only if verified.',
      example: 'USD cash balance 2500',
    },
    Symbol: {
      label: 'security symbol',
      help: 'Use the ticker shown by your broker. Options need the contract symbol or underlying, expiry, strike and call/put details.',
      example: 'Symbol AAPL',
    },
    Expiration: {
      label: 'expiration',
      help: 'Expiration is the option contract expiry date, not its transaction date. A date such as Oct 30, 2026 is accepted.',
      example: '2026-10-30',
    },
  };

export function explainWorkbookQuestion(question: string) {
  const field = Object.entries(fields).find(([key, value]) =>
    new RegExp(`${key}|${value.label}`, 'i').test(question),
  );
  return field
    ? `${field[1].help} Your question has not changed any workbook answers. When ready, reply with the correct value for the tab below; for example, "${field[1].example}" if accurate.`
    : 'I need a verified value for the workbook item below before I can prepare a complete replacement. Your question has not changed any answers. You can describe what is unclear, or check that row in your broker statement. Do not guess a missing value.';
}

export function workbookQuestion(sheet: string, row: number, field: string) {
  const key = Object.keys(fields).find(
    (key) => key.toLowerCase() === field.split('.').at(-1)?.toLowerCase(),
  );
  const info = key ? fields[key] : undefined;
  const location = `Tab "${sheet}"${row ? `, row ${row}` : ''}`;
  return info
    ? `${location}: what is the ${info.label}? ${info.help} Reply with the value, for example "${info.example}" if accurate, or ask me to explain.`
    : `${location}: I could not validate ${field.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}. Please describe what this row represents, or ask me to explain.`;
}

export function nextWorkbookQuestion(
  questions: string[],
  errors: { sheet: string; row: number; field: string; message: string }[],
  inspection?: WorkbookInspection,
) {
  // Never concatenate the validation backlog into a conversational message.
  if (questions.some((q) => q.trim())) return questions.find((q) => q.trim());
  const error = errors[0];
  if (!error) return undefined;
  const field =
    error.field === 'row'
      ? (Object.keys(fields).find((key) =>
          new RegExp(`\\b${key}\\b`, 'i').test(error.message),
        ) ?? error.field)
      : error.field;
  const question = workbookQuestion(error.sheet, error.row, field);
  const table = inspection?.mapping.tables.find(
    (t) =>
      t.sheet === error.sheet &&
      error.row >= t.firstRow &&
      error.row <= t.lastRow,
  );
  const cells = inspection?.sheets.find((s) => s.name === error.sheet)?.rows[
    error.row - 1
  ];
  const details =
    table && cells
      ? [table.columns.Symbol, table.columns.Description]
          .flatMap((column) =>
            column === undefined || !cells[column]?.trim()
              ? []
              : [JSON.stringify(cells[column]!.slice(0, 180))],
          )
          .join(' — ')
      : '';
  return details ? `${question}\nSource: ${details}.` : question;
}
