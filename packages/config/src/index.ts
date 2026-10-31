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
  MARKET_PROVIDER: z.literal('fixture').default('fixture'),
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
// No key is read or retained: M0 has no inference implementation.
export function aiStatus(config: Pick<Config, 'LLM_PROVIDER' | 'LLM_MODEL'>) {
  return {
    provider: config.LLM_PROVIDER,
    model: config.LLM_MODEL,
    available: false as const,
    status: !config.LLM_MODEL.trim()
      ? ('unconfigured' as const)
      : config.LLM_PROVIDER === 'fixture'
        ? ('fixture_only' as const)
        : ('not_implemented' as const),
    message:
      'Inference and analysis modes are scheduled for M2. No model calls are made in M0.',
  };
}
