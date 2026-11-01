import { z } from 'zod';

const configSchema = z.object({
  DATABASE_URL: z.url().refine((value) => /^postgres(ql)?:\/\//.test(value)),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  APP_TIMEZONE: z
    .string()
    .default('America/Vancouver')
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }),
  MARKET_TIMEZONE: z.literal('America/New_York').default('America/New_York'),
  LLM_PROVIDER: z
    .enum(['fixture', 'openai', 'gemini', 'anthropic'])
    .default('fixture'),
  LLM_MODEL: z.string().default('fixture-v1'),
  ANALYSIS_MODE_DEFAULT: z
    .enum(['quick', 'standard', 'extensive'])
    .default('standard'),
  LLM_MAX_STEPS: z.coerce.number().int().min(1).max(16).default(16),
  LLM_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(24).default(24),
  LLM_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(300000)
    .default(60000),
  LLM_RUN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(300000)
    .default(300000),
  LLM_MAX_OUTPUT_TOKENS: z.coerce
    .number()
    .int()
    .min(64)
    .max(8192)
    .default(8192),
  LLM_MAX_INPUT_CHARACTERS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(200000)
    .default(80000),
  LLM_MAX_RUN_COST_USD: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .optional(),
  ),
  LLM_DAILY_BUDGET_USD: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .optional(),
  ),
  LLM_INPUT_USD_PER_MILLION: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .optional(),
  ),
  LLM_OUTPUT_USD_PER_MILLION: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .optional(),
  ),
  LLM_PRICE_VERSION: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(1).optional(),
  ),
  MARKET_PROVIDER: z
    .enum(['fixture', 'twelvedata', 'massive', 'ibkr'])
    .default('fixture'),
  PUBLIC_APP_URL: z
    .url()
    .default('http://127.0.0.1:3000')
    .refine((v) => {
      const u = new URL(v);
      return (
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        u.pathname === '/' &&
        (u.protocol === 'https:' ||
          (u.protocol === 'http:' &&
            ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))
      );
    }),
  BASE_CURRENCY: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default('USD'),
  MARKET_DELAY_MINUTES: z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.coerce.number().int().min(0).max(1440).nullable(),
  ),
});
export type Config = z.infer<typeof configSchema>;
export function readConfig(env: Record<string, string | undefined>): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  return parsed.data;
}
// Safe fallback when no workbook parser is attached; credentials stay in the API composition root.
export function aiStatus(config: Pick<Config, 'LLM_PROVIDER' | 'LLM_MODEL'>) {
  return {
    provider: config.LLM_PROVIDER,
    model: config.LLM_MODEL,
    available: false as const,
    status: !config.LLM_MODEL.trim()
      ? ('unconfigured' as const)
      : config.LLM_PROVIDER === 'fixture'
        ? ('fixture_only' as const)
        : config.LLM_PROVIDER === 'openai'
          ? ('unconfigured' as const)
          : ('not_implemented' as const),
    message:
      'AI workbook parsing requires a configured backend parser. Agent chat uses the separately configured chat service.',
  };
}
