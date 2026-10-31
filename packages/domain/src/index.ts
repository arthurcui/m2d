import { z } from 'zod';

// Boundary contracts only. Accounting and mutation workflows start in M1.
export const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .brand<'DecimalString'>();
export const utcTimestamp = z.iso.datetime();
export const marketEvidenceSchema = z
  .object({
    provider: z.string().min(1),
    session: z.enum([
      'PRE',
      'REGULAR',
      'POST',
      'OVERNIGHT',
      'CLOSED',
      'UNKNOWN',
    ]),
    asOf: utcTimestamp,
    availableAt: utcTimestamp,
    delayedMinutes: z.number().nonnegative().nullable(),
    freshness: z.enum(['FRESH', 'STALE', 'UNKNOWN']),
    quality: z.enum(['VALID', 'DELAYED', 'MISSING', 'INVALID', 'FIXTURE']),
  })
  .strict();
export const confirmationGuardSchema = z
  .object({
    previewId: z.uuid(),
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(1).max(200),
    confirmed: z.literal(true),
  })
  .strict();
export const demoJobSchema = z
  .object({ version: z.literal(1), kind: z.literal('foundation-demo') })
  .strict();
export const DEMO_QUEUE = 'm2d.foundation-demo.v1';
export const HEARTBEAT_STALE_MS = 45_000;
export const DEMO_STALE_MS = 180_000;

export const systemStatusSchema = z.object({
  data: z.object({
    milestone: z.literal('M3'),
    database: z.enum(['ready', 'unavailable']),
    worker: z.object({
      status: z.enum(['online', 'stale', 'unavailable']),
      lastHeartbeat: utcTimestamp.nullable(),
      lastDemoJob: utcTimestamp.nullable(),
      scheduler: z.enum(['healthy', 'stale', 'waiting', 'unavailable']),
    }),
    ai: z.object({
      provider: z.string(),
      model: z.string(),
      available: z.boolean(),
      status: z.enum([
        'fixture_only',
        'not_implemented',
        'unconfigured',
        'ready',
      ]),
      message: z.string(),
    }),
    market: z.object({
      provider: z.enum(['fixture', 'twelvedata']),
      status: z.enum([
        'not_implemented',
        'fixture_only',
        'ready',
        'unconfigured',
      ]),
    }),
    displayTimezone: z.string(),
    marketTimezone: z.literal('America/New_York'),
  }),
  meta: z.object({
    version: z.literal(1),
    asOf: utcTimestamp,
    source: z.literal('m2d-system'),
    dataQuality: z.literal('OPERATIONAL'),
  }),
});
export type SystemStatus = z.infer<typeof systemStatusSchema>;

export function freshness(
  timestamp: Date | null,
  now: Date,
  maxAge: number,
): boolean {
  if (!timestamp) return false;
  const age = now.getTime() - timestamp.getTime();
  return age >= 0 && age <= maxAge;
}
