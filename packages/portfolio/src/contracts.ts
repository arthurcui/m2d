import { z } from 'zod';
import { Decimal } from 'decimal.js';

export const amount = z
  .string()
  .regex(
    /^-?\d{1,18}(\.\d{1,12})?$/,
    'Use a decimal string (up to 18 integer and 12 fractional digits)',
  )
  .transform((v) => new Decimal(v).toFixed());
export const nonnegative = amount.refine(
  (v) => new Decimal(v).gte(0),
  'Must be nonnegative',
);
export const positive = amount.refine(
  (v) => new Decimal(v).gt(0),
  'Must be positive',
);
export const currency = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .refine(
    (v) => Intl.supportedValuesOf('currency').includes(v),
    'Use a recognized three-letter currency code',
  );
export const timestamp = z.iso.datetime();
const key = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
export const accountSchema = z
  .object({
    accountKey: key,
    displayName: z.string().trim().min(1).max(120),
    institution: z.string().trim().max(120),
    accountType: z.enum(['CASH', 'MARGIN', 'RRSP', 'TFSA', 'OTHER']),
    baseCurrency: currency,
    active: z.boolean(),
    notes: z.string().max(1000).default(''),
  })
  .strict();
export const instrumentSchema = z
  .object({
    assetType: z.enum(['STOCK', 'ETF', 'OPTION']),
    symbol: z.string().regex(/^[A-Z0-9.^-]{1,24}$/),
    exchange: z.string().regex(/^[A-Z0-9.-]{1,20}$/),
    currency,
    optionRight: z.enum(['CALL', 'PUT']).nullable(),
    expiry: z.iso.date().nullable(),
    strike: positive.nullable(),
    multiplier: positive,
    underlying: z
      .string()
      .regex(/^[A-Z0-9.^-]{1,24}$/)
      .nullable(),
    deliverable: z.literal('STANDARD').nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const option = v.assetType === 'OPTION';
    if (
      option &&
      (!v.optionRight ||
        !v.expiry ||
        !v.strike ||
        !v.underlying ||
        v.deliverable !== 'STANDARD' ||
        v.multiplier !== '100')
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'M1 accepts explicit standard 100-share equity options only; adjusted deliverables require reconciliation.',
      });
    if (
      !option &&
      (v.optionRight ||
        v.expiry ||
        v.strike ||
        v.underlying ||
        v.deliverable ||
        v.multiplier !== '1')
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Stocks/ETFs require multiplier 1 and empty option fields.',
      });
  });
export type Instrument = z.infer<typeof instrumentSchema>;
export function instrumentKey(v: Instrument) {
  return [
    v.assetType,
    v.symbol,
    v.exchange,
    v.currency,
    v.optionRight ?? '',
    v.expiry ?? '',
    v.strike ?? '',
    v.multiplier,
    v.underlying ?? '',
    v.deliverable ?? '',
  ].join('|');
}
export const positionSchema = z
  .object({
    accountKey: key,
    instrument: instrumentSchema,
    quantity: amount,
    averageCost: nonnegative.nullable(),
    description: z.string().max(1000).optional(),
    optionGroup: z.string().max(120).optional(),
    transactionDate: z.iso.date().optional(),
    quality: z.enum(['BASELINE_ESTIMATE', 'COMPLETE_LEDGER', 'UNKNOWN']),
    notes: z.string().max(1000).default(''),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.averageCost === null && v.quality !== 'UNKNOWN')
      ctx.addIssue({
        code: 'custom',
        message: 'Missing unit cost must be UNKNOWN.',
      });
    if (v.optionGroup && v.instrument.assetType !== 'OPTION')
      ctx.addIssue({
        code: 'custom',
        message: 'Only option legs can belong to an option group.',
      });
    if (
      v.instrument.assetType === 'OPTION' &&
      !new Decimal(v.quantity).isInteger()
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Option quantities must be whole contracts.',
      });
  });
export const cashSchema = z
  .object({ accountKey: key, currency, balance: amount })
  .strict();
export const stateSchema = z
  .object({
    accounts: z.array(accountSchema).max(100),
    positions: z.array(positionSchema).max(2000),
    cash: z.array(cashSchema).max(200),
  })
  .strict()
  .superRefine((s, ctx) => {
    const accounts = new Map(s.accounts.map((a) => [a.accountKey, a]));
    if (accounts.size !== s.accounts.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate AccountKey.' });
    for (const [name, rows, keys] of [
      [
        'Positions',
        s.positions,
        s.positions.map(
          (p) => `${p.accountKey}:${instrumentKey(p.instrument)}`,
        ),
      ],
      ['Cash', s.cash, s.cash.map((c) => `${c.accountKey}:${c.currency}`)],
    ] as const) {
      if (new Set(keys).size !== keys.length)
        ctx.addIssue({ code: 'custom', message: `Duplicate ${name} row.` });
      rows.forEach((row) => {
        const a = accounts.get(row.accountKey);
        if (!a)
          ctx.addIssue({
            code: 'custom',
            message: `Unknown account ${row.accountKey}.`,
          });
        else if (
          !a.active &&
          ('quantity' in row
            ? new Decimal(row.quantity).isZero() === false
            : new Decimal(row.balance).isZero() === false)
        )
          ctx.addIssue({
            code: 'custom',
            message: `Inactive account ${row.accountKey} has a nonzero holding or balance.`,
          });
      });
    }
    for (const a of s.accounts)
      if (
        !s.cash.some(
          (c) => c.accountKey === a.accountKey && c.currency === a.baseCurrency,
        )
      )
        ctx.addIssue({
          code: 'custom',
          message: `Include explicit ${a.baseCurrency} cash for ${a.accountKey}, even when zero.`,
        });
  });
export type Account = z.infer<typeof accountSchema>;
export type Position = z.infer<typeof positionSchema>;
export type State = z.infer<typeof stateSchema>;
export const emptyState = (): State => ({
  accounts: [],
  positions: [],
  cash: [],
});
const common = {
  effectiveAt: timestamp,
  note: z.string().trim().min(1).max(1000),
  correctionOf: z.uuid().optional(),
};
export const operationSchema = z.discriminatedUnion('kind', [
  z
    .object({ ...common, kind: z.literal('NOTE_ONLY'), accountKey: key })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('ACCOUNT_UPSERT'),
      account: accountSchema,
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.enum([
        'STOCK_BUY',
        'STOCK_SELL',
        'STOCK_SHORT',
        'STOCK_COVER',
        'OPTION_BTO',
        'OPTION_STO',
        'OPTION_BTC',
        'OPTION_STC',
      ]),
      accountKey: key,
      instrument: instrumentSchema,
      quantity: positive,
      price: nonnegative,
      fees: nonnegative,
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.enum([
        'CASH_SET',
        'CASH_DEPOSIT',
        'CASH_WITHDRAW',
        'FEE',
        'DIVIDEND',
      ]),
      accountKey: key,
      currency,
      amount: amount,
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('CASH_TRANSFER'),
      accountKey: key,
      toAccountKey: key,
      currency,
      amount: positive,
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('ADJUST_POSITION'),
      accountKey: key,
      instrument: instrumentSchema,
      quantity: amount,
      averageCost: nonnegative,
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.enum(['OPTION_EXPIRE', 'OPTION_ASSIGN', 'OPTION_EXERCISE']),
      accountKey: key,
      instrument: instrumentSchema,
      quantity: positive,
      fees: nonnegative,
      settlementConfirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('SPLIT'),
      accountKey: key,
      instrument: instrumentSchema,
      numerator: positive,
      denominator: positive,
    })
    .strict(),
]);
export type Operation = z.infer<typeof operationSchema>;
export const previewRequestSchema = z
  .object({
    version: z.literal(1),
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(1).max(100),
    operation: operationSchema,
  })
  .strict();
export const confirmSchema = z
  .object({
    version: z.literal(1),
    expectedRevision: z.number().int().nonnegative(),
    confirmed: z.literal(true),
    fullReplacementAcknowledged: z.boolean().optional(),
  })
  .strict();
export type Change = {
  area: 'account' | 'position' | 'cash';
  key: string;
  before: string;
  after: string;
};
export type Realized = {
  accountKey: string;
  currency: string;
  amount: string;
  quality: Position['quality'];
};
export class PortfolioError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details: unknown = null,
  ) {
    super(message);
  }
}
export const fail = (code: string, message: string, status = 400): never => {
  throw new PortfolioError(code, message, status);
};
