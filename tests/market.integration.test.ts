import { randomUUID } from 'node:crypto';
import { createMarketSelection } from '../apps/api/src/market-selection.js';
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { createDatabase } from '../packages/db/src/index.js';
import { migrateDatabase } from '../packages/db/src/migrate.js';
import {
  FixtureMarketProvider,
  MarketError,
  massiveCompletedDate,
  type MarketProvider,
} from '../packages/market/src/index.js';
import { createMarketService } from '../apps/api/src/market.js';
import { buildApp } from '../apps/api/src/app.js';
import { readConfig } from '../packages/config/src/index.js';
import { MarketError as ProviderMarketError } from '../packages/market/dist/index.js';
import type { Instrument } from '../packages/portfolio/src/index.js';
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error(
    'TEST_DATABASE_URL must point to a disposable PostgreSQL database.',
  );
const admin = createDatabase(url),
  name = `m2d_market_test_${randomUUID().replaceAll('-', '')}`;
const target = new URL(url);
target.pathname = `/${name}`;
const db = createDatabase(target.toString()),
  provider = new FixtureMarketProvider();
const service = createMarketService(db.market, db.portfolio, provider, 'USD');
const app = buildApp(
  db.repository,
  readConfig({ DATABASE_URL: target.toString() }),
  false,
  db.portfolio,
  undefined,
  { repository: db.market, provider, service },
);
const instrument: Instrument = {
  assetType: 'STOCK',
  symbol: 'TSLA',
  exchange: 'NASDAQ',
  currency: 'USD',
  optionRight: null,
  expiry: null,
  strike: null,
  multiplier: '1',
  underlying: null,
  deliverable: null,
};

beforeAll(async () => {
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  await migrateDatabase(target.toString());
  await migrateDatabase(target.toString());
});
afterAll(async () => {
  await app.close();
  await db.close();
  await admin.pool.query(`DROP DATABASE "${name}"`);
  await admin.close();
});
it('persists raw evidence, deduplicates refreshes, rejects key reuse and leaves portfolio unchanged', async () => {
  const key = randomUUID(),
    request = { kind: 'quote' as const, instrument };
  const first = await db.market.refresh(key, request, provider),
    second = await db.market.refresh(key, request, provider);
  expect(first.status).toBe('SUCCEEDED');
  expect(second.duplicate).toBe(true);
  expect(second.observationId).toBe(first.observationId);
  await expect(
    db.market.refresh(key, { kind: 'bars', symbol: 'TSLA' }, provider),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  const raw = await db.pool.query(
    'select raw,payload,available_at from market_observations',
  );
  expect(raw.rowCount).toBe(1);
  expect(raw.rows[0].raw.fixture).toBe('market-v1');
  expect(new Date(raw.rows[0].payload.value.availableAt).getTime()).toBe(
    new Date(raw.rows[0].available_at).getTime(),
  );
  expect((await db.portfolio.overview()).revision).toBe(0);
});
it('keeps last good data on failure, permits point-in-time reads, and persists snapshot idempotence', async () => {
  const faulty: MarketProvider = {
    id: 'fixture',
    configured: true,
    quote: async () => {
      throw new MarketError('INVALID_MARKET_DATA', 'Bad response');
    },
    bars: (s) => provider.bars(s),
    fx: (b, q) => provider.fx(b, q),
    options: (s, e) => provider.options(s, e),
  };
  const key = randomUUID();
  expect(
    (await db.market.refresh(key, { kind: 'quote', instrument }, faulty))
      .status,
  ).toBe('FAILED');
  const response = await app.inject({
    url: '/api/v1/market/quotes?symbol=TSLA',
  });
  expect(response.json().data.payload.value.last).toBe('400');
  expect(
    await db.market.read(
      'fixture',
      'quote',
      instrument.assetType + '|TSLA|NASDAQ|USD||||1||',
      '2026-01-01T00:00:00Z',
    ),
  ).toBeNull();
  const value = await service.valuation(),
    snapshotKey = randomUUID();
  const a = await db.market.saveSnapshot(
      snapshotKey,
      0,
      'fixture',
      value,
      value.observationIds,
    ),
    b = await db.market.saveSnapshot(snapshotKey, 0, 'fixture', value, []);
  expect(a.id).toBe(b.id);
});
it('API validates inputs and rejects cross-origin refreshes', async () => {
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/market/refresh',
        payload: {
          version: 1,
          idempotencyKey: randomUUID(),
          request: { kind: 'bars', symbol: 'bad/symbol' },
        },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/market/refresh',
        headers: { origin: 'https://attacker.invalid' },
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await app.inject({ url: '/api/v1/market/status' })).json().data.provider,
  ).toBe('fixture');
});
it('recovers interrupted refreshes without repeating external calls', async () => {
  const key = randomUUID();
  await db.pool.query(
    "insert into market_refreshes(request_key,fingerprint,provider,subject,status) values($1,'interrupted','fixture','TSLA','PENDING')",
    [key],
  );
  await db.market.recover();
  const result = await db.pool.query(
    'select status,error_code from market_refreshes where request_key=$1',
    [key],
  );
  expect(result.rows[0]).toEqual({
    status: 'FAILED',
    error_code: 'REFRESH_INTERRUPTED',
  });
  expect((await db.portfolio.overview()).revision).toBe(0);
});

it('persists the Basic HTTP allowance across repository instances without consuming queued slots', async () => {
  expect(await db.market.reserveMassiveRequest()).toBe(0);
  const other = createDatabase(target.toString());
  try {
    const waits = await Promise.all([
      db.market.reserveMassiveRequest(),
      other.market.reserveMassiveRequest(),
    ]);
    expect(waits.every((ms) => ms > 0 && ms <= 13000)).toBe(true);
    await db.pool.query(
      "update market_provider_limits set next_allowed_at=clock_timestamp()-interval '1 second' where provider='massive'",
    );
    expect(await other.market.reserveMassiveRequest()).toBe(0);
    await expect(
      db.pool.query(
        "insert into market_provider_limits(provider,next_allowed_at) values('unknown',now())",
      ),
    ).rejects.toThrow();
  } finally {
    await other.close();
  }
});

it('caches completed-day Massive evidence, retains idempotency and does not let unavailable feeds block holdings', async () => {
  let calls = 0;
  let failureCode: string | undefined;
  const basic: MarketProvider = {
    id: 'massive',
    configured: true,
    quote: async (i) => {
      calls++;
      if (failureCode)
        throw new ProviderMarketError(failureCode, 'Test failure');
      return {
        raw: { example: 'massive-basic' },
        payload: {
          kind: 'quote',
          value: {
            provider: 'massive',
            sourceRecordId: 'example',
            asOf: `${massiveCompletedDate(Date.now())}T20:00:00Z`,
            receivedAt: new Date().toISOString(),
            availableAt: new Date().toISOString(),
            session: 'CLOSED',
            delayedMinutes: null,
            quality: 'DELAYED',
            entitlement: 'Basic EOD',
            instrument: i,
            bid: null,
            ask: null,
            last: '400',
            kind: 'EOD_CLOSE',
          },
        },
      };
    },
    bars: (s) => provider.bars(s),
    fx: (b, q) => provider.fx(b, q),
    options: (s, e) => provider.options(s, e),
  };
  await expect(
    db.market.refresh(
      randomUUID(),
      { kind: 'options', symbol: 'TSLA', expiry: '2026-12-18' },
      basic,
    ),
  ).rejects.toMatchObject({ code: 'OPTIONS_UNAVAILABLE' });
  await expect(
    db.market.refresh(
      randomUUID(),
      { kind: 'fx', base: 'CAD', quote: 'USD' },
      basic,
    ),
  ).rejects.toMatchObject({ code: 'FX_UNAVAILABLE' });
  const first = await db.market.refresh(
    randomUUID(),
    { kind: 'quote', instrument },
    basic,
  );
  expect(first.status).toBe('SUCCEEDED');
  const key = randomUUID();
  const cached = await db.market.refresh(
    key,
    { kind: 'quote', instrument },
    basic,
  );
  expect(cached).toMatchObject({
    status: 'SUCCEEDED',
    cached: true,
    observationId: first.observationId,
  });
  expect(
    (await db.market.refresh(key, { kind: 'quote', instrument }, basic))
      .duplicate,
  ).toBe(true);
  expect(calls).toBe(1);
  const allowance = await db.pool.query(
    "select next_allowed_at from market_provider_limits where provider='massive'",
  );
  failureCode = 'NO_COVERAGE';
  expect(
    (
      await db.market.refresh(
        randomUUID(),
        { kind: 'quote', instrument: { ...instrument, symbol: 'MISSING' } },
        basic,
      )
    ).status,
  ).toBe('FAILED');
  expect(
    (
      await db.pool.query(
        "select next_allowed_at from market_provider_limits where provider='massive'",
      )
    ).rows,
  ).toEqual(allowance.rows);
  failureCode = undefined;
  expect(
    (
      await db.market.refresh(
        randomUUID(),
        { kind: 'quote', instrument: { ...instrument, symbol: 'NVDA' } },
        basic,
      )
    ).status,
  ).toBe('SUCCEEDED');
  failureCode = 'MARKET_RATE_LIMIT';
  expect(
    (
      await db.market.refresh(
        randomUUID(),
        { kind: 'quote', instrument: { ...instrument, symbol: 'LIMITED' } },
        basic,
      )
    ).status,
  ).toBe('FAILED');
  await expect(
    db.market.refresh(
      randomUUID(),
      { kind: 'quote', instrument: { ...instrument, symbol: 'BLOCKED' } },
      basic,
    ),
  ).rejects.toMatchObject({ code: 'MARKET_RATE_LIMIT' });
  expect((await db.portfolio.overview()).revision).toBe(0);
  const basicService = createMarketService(
    db.market,
    db.portfolio,
    basic,
    'USD',
  );
  expect((await basicService.status()).description).toContain('end-of-day');
});

it('persists IBKR evidence and pacing without changing portfolio state', async () => {
  let calls = 0;
  const unexpected = async () => {
    throw new Error('Unexpected feed');
  };
  const ibkr: MarketProvider = {
    id: 'ibkr',
    configured: true,
    quote: async (i) => {
      calls++;
      const fixture = await provider.quote(i);
      if (fixture.payload.kind !== 'quote') throw new Error('Expected quote');
      return {
        raw: { test: 'ibkr-mcp' },
        payload: {
          kind: 'quote',
          value: {
            ...fixture.payload.value,
            provider: 'ibkr',
            quality: 'UNKNOWN',
          },
        },
      };
    },
    bars: unexpected,
    options: unexpected,
    fx: unexpected,
  };
  const key = randomUUID();
  const first = await db.market.refresh(
    key,
    { kind: 'quote', instrument },
    ibkr,
  );
  const repeated = await db.market.refresh(
    key,
    { kind: 'quote', instrument },
    ibkr,
  );
  expect(first.status).toBe('SUCCEEDED');
  expect(repeated.duplicate).toBe(true);
  expect(calls).toBe(1);
  expect(
    (await db.market.read('ibkr', 'quote', 'STOCK|TSLA|NASDAQ|USD||||1||'))
      ?.payload,
  ).toMatchObject({ kind: 'quote', value: { provider: 'ibkr' } });
  await db.market.waitForIbkrRequest();
  const gate = await db.pool.query(
    "select next_allowed_at > clock_timestamp() as reserved from market_provider_limits where provider='ibkr'",
  );
  expect(gate.rows[0].reserved).toBe(true);
  expect((await db.portfolio.overview()).revision).toBe(0);
});

it('caches listing evidence and serves logos without changing the portfolio or price source', async () => {
  const before = await db.portfolio.overview();
  const lookup = {
    symbol: 'TSLA',
    exchange: 'NASDAQ',
    currency: 'USD',
    assetType: 'STOCK' as const,
  };
  let calls = 0;
  class Listings extends FixtureMarketProvider {
    override async fetchListing(input: typeof lookup) {
      calls++;
      const result = await super.fetchListing(input);
      if (
        calls > 1 &&
        result.payload.kind === 'listing' &&
        result.payload.value.logo
      )
        result.payload.value.logo.base64 = Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="green"/></svg>',
        ).toString('base64');
      return result;
    }
  }
  const listings = new Listings();
  const request = { kind: 'listing' as const, lookup };
  const first = await db.market.refresh(randomUUID(), request, listings);
  const cached = await db.market.refresh(randomUUID(), request, listings);
  expect(cached).toMatchObject({
    status: 'SUCCEEDED',
    observationId: first.observationId,
    cached: true,
  });
  expect(calls).toBe(1);
  const realNow = Date.now();
  const advanced = vi
    .spyOn(Date, 'now')
    .mockReturnValue(realNow + 8 * 86400000);
  try {
    const renewed = await db.market.refresh(randomUUID(), request, listings);
    expect(renewed.status).toBe('SUCCEEDED');
    expect(renewed.observationId).not.toBe(first.observationId);
    expect(calls).toBe(2);
  } finally {
    advanced.mockRestore();
  }
  const portfolio = {
    ...db.portfolio,
    overview: async () => ({
      ...before,
      state: {
        ...before.state,
        positions: [
          {
            accountKey: 'TEST',
            instrument,
            quantity: '2',
            averageCost: '100',
            quality: 'COMPLETE_LEDGER' as const,
            notes: '',
            description: 'STOCK',
          },
        ],
      },
    }),
  };
  const withListings = createMarketService(
    db.market,
    portfolio,
    provider,
    'USD',
    listings,
  );
  const api = buildApp(
    db.repository,
    readConfig({ DATABASE_URL: target.toString() }),
    false,
    db.portfolio,
    undefined,
    {
      repository: db.market,
      provider,
      listingProvider: listings,
      service: withListings,
    },
  );
  try {
    const response = await api.inject('/api/v1/portfolio/listings');
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.listings['TSLA:NASDAQ:USD:STOCK'].name).toBe('Tesla, Inc.');
    expect(data.requests).toEqual([]);
    expect(response.body).not.toContain('base64');
    const image = await api.inject(
      data.listings['TSLA:NASDAQ:USD:STOCK'].logoUrl,
    );
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toContain('image/svg+xml');
    expect(image.headers['content-security-policy']).toContain('sandbox');
    expect(image.body).toContain('<svg');
    expect(
      (await api.inject(`/api/v1/market/listings/${randomUUID()}/logo`))
        .statusCode,
    ).toBe(404);
    expect(calls).toBe(2);
    expect(await db.portfolio.overview()).toEqual(before);
  } finally {
    await api.close();
  }
});

it('saves independent providers, fences stale requests and keeps an in-flight result under its original source', async () => {
  const before = await db.portfolio.overview();
  let release = () => {};
  let started = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const ibkr: MarketProvider = {
    id: 'ibkr',
    configured: true,
    quote: async (input) => {
      calls++;
      started();
      await waiting;
      const result = await provider.quote(input);
      if (result.payload.kind === 'quote')
        result.payload.value.provider = 'ibkr';
      return result;
    },
    bars: (s) => provider.bars(s),
    options: (s, e) => provider.options(s, e),
    fx: (a, b) => provider.fx(a, b),
    fetchListing: (lookup) => provider.fetchListing(lookup),
  };
  const registry = {
    fixture: provider,
    ibkr,
    massive: { ...ibkr, id: 'massive' as const, configured: false },
    twelvedata: { ...ibkr, id: 'twelvedata' as const, configured: false },
  };
  const selection = createMarketSelection(db.market, registry, {
    priceProvider: 'fixture',
    listingProvider: 'fixture',
  });
  const api = buildApp(
    db.repository,
    readConfig({ DATABASE_URL: target.toString() }),
    false,
    db.portfolio,
    undefined,
    {
      repository: db.market,
      provider,
      listingProvider: provider,
      selection,
      service: createMarketService(
        db.market,
        db.portfolio,
        provider,
        'USD',
        provider,
        selection,
      ),
    },
  );
  const patch = async (body: object) =>
    api.inject({
      method: 'POST',
      url: '/api/v1/market/settings',
      payload: body,
    });
  try {
    const initial = (await api.inject('/api/v1/market/settings')).json().data;
    const enabled = await patch({
      version: 1,
      revision: initial.revision,
      refreshSeconds: 30,
    });
    expect(enabled.statusCode).toBe(200);
    const selected = await patch({
      version: 1,
      revision: enabled.json().data.revision,
      priceProvider: 'ibkr',
    });
    expect(selected.json().data).toMatchObject({
      priceProvider: 'ibkr',
      listingProvider: 'fixture',
      refreshSeconds: 0,
    });
    const system = await api.inject('/api/v1/system/status');
    expect(system.statusCode, system.body).toBe(200);
    expect(system.json().data.market.provider).toBe('ibkr');
    expect(
      (await api.inject('/api/v1/portfolio/listings')).json().data.provider,
    ).toBe('fixture');
    const blocked = await api.inject({
      method: 'POST',
      url: '/api/v1/market/refresh',
      payload: {
        version: 1,
        idempotencyKey: randomUUID(),
        expectedProvider: 'fixture',
        request: { kind: 'quote', instrument },
      },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('PROVIDER_CHANGED');
    expect(calls).toBe(0);
    // Capture the chosen instance before the asynchronous request starts.
    const pending = api
      .inject({
        method: 'POST',
        url: '/api/v1/market/refresh',
        payload: {
          version: 1,
          idempotencyKey: randomUUID(),
          expectedProvider: 'ibkr',
          request: {
            kind: 'quote',
            instrument: { ...instrument, symbol: 'NVDA' },
          },
        },
      })
      .then((r) => r);
    await entered;
    const switched = await patch({
      version: 1,
      revision: selected.json().data.revision,
      priceProvider: 'fixture',
      listingProvider: 'none',
    });
    expect(switched.statusCode).toBe(200);
    release();
    expect((await pending).json().meta.source).toBe('ibkr');
    expect(calls).toBe(1);
    const stored = await db.market.read(
      'ibkr',
      'quote',
      'STOCK|NVDA|NASDAQ|USD||||1||',
    );
    expect(stored?.payload).toMatchObject({
      kind: 'quote',
      value: { provider: 'ibkr' },
    });
    const active = await api.inject('/api/v1/market/quotes?symbol=NVDA');
    expect(active.json()).toMatchObject({
      data: null,
      meta: { source: 'fixture' },
    });
    const reloaded = createMarketSelection(db.market, registry, {
      priceProvider: 'ibkr',
      listingProvider: 'ibkr',
    });
    expect(await reloaded.settings()).toMatchObject({
      priceProvider: 'fixture',
      listingProvider: 'none',
    });
    expect(
      (
        await patch({
          version: 1,
          revision: initial.revision,
          listingProvider: 'fixture',
        })
      ).statusCode,
    ).toBe(409);
    const current = await reloaded.settings();
    expect(
      (
        await patch({
          version: 1,
          revision: current.revision,
          priceProvider: 'massive',
        })
      ).statusCode,
    ).toBe(409);
    await expect(
      db.pool.query(
        'update app_settings set price_refresh_seconds=1 where id=1',
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await db.portfolio.overview()).toEqual(before);
  } finally {
    release();
    await api.close();
  }
});
