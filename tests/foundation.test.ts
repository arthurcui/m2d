import { describe, expect, it } from 'vitest';
import { readConfig, aiStatus } from '../packages/config/src/index.js';
import {
  confirmationGuardSchema,
  decimalString,
  freshness,
  marketEvidenceSchema,
} from '../packages/domain/src/index.js';
import { handleDemoJob } from '../apps/worker/src/jobs.js';
import fixture from '../fixtures/foundation-demo.json' with { type: 'json' };

describe('offline foundation configuration', () => {
  it('needs only a database URL, never an API key', () => {
    const config = readConfig({ DATABASE_URL: 'postgresql://localhost/m2d' });
    expect(aiStatus(config)).toMatchObject({
      provider: 'fixture',
      available: false,
      status: 'fixture_only',
    });
    expect(config.APP_TIMEZONE).toBe('America/Vancouver');
  });
  it('does not silently substitute fixture for an unconfigured provider', () => {
    expect(
      aiStatus(
        readConfig({
          DATABASE_URL: 'postgres://localhost/m2d',
          LLM_PROVIDER: 'openai',
          LLM_MODEL: 'explicit-model',
        }),
      ),
    ).toMatchObject({
      provider: 'openai',
      status: 'unconfigured',
      available: false,
    });
    expect(aiStatus({ LLM_PROVIDER: 'openai', LLM_MODEL: '' }).status).toBe(
      'unconfigured',
    );
  });
  it('rejects invalid configuration without reflecting secrets', () => {
    expect(() => readConfig({ DATABASE_URL: 'secret-value' })).toThrow(
      'Invalid configuration: DATABASE_URL',
    );
    expect(() =>
      readConfig({ DATABASE_URL: 'postgres://localhost/db', API_PORT: '0' }),
    ).toThrow('API_PORT');
    expect(() =>
      readConfig({
        DATABASE_URL: 'postgres://localhost/db',
        MARKET_PROVIDER: 'live',
      }),
    ).toThrow('MARKET_PROVIDER');
  });
});
describe('guardrail contracts', () => {
  it('accepts signed decimal strings but rejects floats and nonfinite values', () => {
    expect(decimalString.parse('-1.25')).toBe('-1.25');
    for (const value of [1.25, 'NaN', 'Infinity', '1e3'])
      expect(decimalString.safeParse(value).success).toBe(false);
  });
  it('requires explicit confirmation and complete provenance', () => {
    expect(
      confirmationGuardSchema.safeParse({ confirmed: false }).success,
    ).toBe(false);
    expect(
      marketEvidenceSchema.safeParse({ provider: 'fixture' }).success,
    ).toBe(false);
  });
  it('marks missing, old, and future heartbeat timestamps as stale', () => {
    const now = new Date('2026-10-30T12:00:00Z');
    expect(freshness(new Date('2026-10-30T11:59:50Z'), now, 45000)).toBe(true);
    expect(freshness(null, now, 45000)).toBe(false);
    expect(freshness(new Date('2026-10-30T11:59:00Z'), now, 45000)).toBe(false);
    expect(freshness(new Date('2026-10-30T12:01:00Z'), now, 45000)).toBe(false);
  });
});
describe('demo job boundary', () => {
  it('validates before touching persistence and passes a stable job ID on retry', async () => {
    const ids = new Set<string>();
    const record = async (id: string) => {
      const fresh = !ids.has(id);
      ids.add(id);
      return fresh;
    };
    await expect(
      handleDemoJob({ id: 'job-1', data: { version: 2 } }, record),
    ).rejects.toThrow();
    expect(ids.size).toBe(0);
    expect(await handleDemoJob({ id: 'job-1', data: fixture }, record)).toBe(
      true,
    );
    expect(await handleDemoJob({ id: 'job-1', data: fixture }, record)).toBe(
      false,
    );
  });
});
