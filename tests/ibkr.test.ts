import { describe, it, expect, vi } from 'vitest';
import {
  IbkrMcpMarketDataProvider,
  type IbkrReadTool,
  type IbkrSession,
} from '../packages/market/src/ibkr.js';
import {
  IbkrConnection,
  IBKR_MCP_URL,
  ibkrFileStore,
  type IbkrSecretStore,
} from '../packages/market/src/ibkr-connection.js';
import { mkdtemp, readFile, stat, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Instrument } from '../packages/portfolio/src/index.js';
const now = Date.parse('2026-10-31T18:00:00Z');
const stamp = Date.parse('2026-10-30T19:59:00Z') / 1000;
const instrument: Instrument = {
  assetType: 'STOCK',
  symbol: 'TSLA',
  exchange: 'UNKNOWN',
  currency: 'USD',
  optionRight: null,
  expiry: null,
  strike: null,
  multiplier: '1',
  underlying: null,
  deliverable: null,
};
const listing = {
  results: [
    {
      underlying_contract_id: 123,
      symbol: 'TSLA',
      exchange: 'NASDAQ',
      country_code: 'US',
      sections: [{ security_type: 'STK' }, { security_type: 'OPT' }],
    },
  ],
};
const snapshot = {
  last: { price: '400.123456789123', ts: stamp },
  'bid-ask': { bid: '401', ask: '402' },
  'top-status': { status: 'FROZEN' },
};
const parameters = {
  current_exchange: 'SMART',
  expirations: [
    { id: 'opaque-expiration-id', date: '20261127', trading_class: 'TSLA' },
  ],
};
const chain = {
  currency: 'USD',
  exchange: 'SMART',
  contracts: [
    {
      strike: '440',
      call_contract_id: 456,
      put_contract_id: 789,
      call_description: "TSLA NOV 27 '26 440 Call",
      put_description: "TSLA NOV 27 '26 440 Put",
    },
  ],
};
function provider(
  responses: Partial<Record<IbkrReadTool, unknown>> = {},
  connected = true,
) {
  const defaults: Partial<Record<IbkrReadTool, unknown>> = {
    search_contracts: listing,
    get_price_snapshot: snapshot,
    get_option_parameters: parameters,
    get_option_data: chain,
  };
  const call = vi.fn<IbkrSession['call']>(async (name) => ({
    data: responses[name] ?? defaults[name],
    raw: { name },
  }));
  const close = vi.fn(async () => {});
  return {
    p: new IbkrMcpMarketDataProvider(
      async () => ({ call, close }),
      () => connected,
      () => now,
    ),
    call,
    close,
  };
}
describe('IBKR market normalization', () => {
  it('stops further tool calls when a slow refresh exhausts its time allowance', async () => {
    let current = now;
    const call = vi.fn<IbkrSession['call']>(async (name) => {
      current += 45001;
      return {
        data: name === 'search_contracts' ? listing : parameters,
        raw: {},
      };
    });
    const close = vi.fn(async () => {});
    const p = new IbkrMcpMarketDataProvider(
      async () => ({ call, close }),
      () => true,
      () => current,
    );
    await expect(
      p.quote({
        ...instrument,
        assetType: 'OPTION',
        underlying: 'TSLA',
        expiry: '2026-11-27',
        strike: '440',
        optionRight: 'CALL',
        multiplier: '100',
        deliverable: 'STANDARD',
      }),
    ).rejects.toMatchObject({ code: 'IBKR_WORK_LIMIT' });
    expect(call).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });
  it('preserves imported identity, source time and decimal precision; omits an untimestamped book', async () => {
    const { p, close } = provider();
    expect((await p.quote(instrument)).payload).toMatchObject({
      kind: 'quote',
      value: {
        instrument,
        resolvedExchange: 'NASDAQ',
        provider: 'ibkr',
        last: '400.123456789123',
        bid: null,
        ask: null,
        quality: 'UNKNOWN',
        delayedMinutes: null,
        asOf: new Date(stamp * 1000).toISOString(),
      },
    });
    expect(close).toHaveBeenCalledOnce();
  });
  it('does not use a missing last-trade timestamp or a prior close as a current mark', async () => {
    await expect(
      provider({
        get_price_snapshot: {
          last: { price: '400' },
          'prior-close': { price: '399', ts: stamp },
        },
      }).p.quote(instrument),
    ).rejects.toMatchObject({ code: 'NO_COVERAGE' });
  });
  it('validates an independently timestamped bid/ask', async () => {
    const result = await provider({
      get_price_snapshot: { 'bid-ask': { bid: '400', ask: '401', ts: stamp } },
    }).p.quote(instrument);
    expect(result.payload).toMatchObject({
      value: { bid: '400', ask: '401', last: null },
    });
    await expect(
      provider({
        get_price_snapshot: {
          'bid-ask': { bid: '402', ask: '401', ts: stamp },
        },
      }).p.quote(instrument),
    ).rejects.toMatchObject({ code: 'INVALID_MARKET_DATA' });
  });
  it('rejects future timestamps, halted prices and conflicting listings', async () => {
    for (const data of [
      { last: { price: '400', ts: now / 1000 + 10 } },
      { last: { price: '400', ts: stamp, halted: true } },
    ])
      await expect(
        provider({ get_price_snapshot: data }).p.quote(instrument),
      ).rejects.toMatchObject({ code: 'INVALID_MARKET_DATA' });
    for (const patch of [
      { symbol: 'TSLL' },
      { country_code: 'CA' },
      { exchange: 'TSE' },
    ])
      await expect(
        provider({
          search_contracts: { results: [{ ...listing.results[0], ...patch }] },
        }).p.quote(instrument),
      ).rejects.toMatchObject({ code: 'INSTRUMENT_MISMATCH' });
    await expect(
      provider({
        search_contracts: { results: [...listing.results, ...listing.results] },
      }).p.quote(instrument),
    ).rejects.toMatchObject({ code: 'INSTRUMENT_MISMATCH' });
    await expect(
      provider().p.quote({ ...instrument, exchange: 'NYSE' }),
    ).rejects.toMatchObject({ code: 'INSTRUMENT_MISMATCH' });
  });
  it('supports recorded ETF class without rewriting it', async () => {
    expect(
      (await provider().p.quote({ ...instrument, assetType: 'ETF' })).payload,
    ).toMatchObject({ value: { instrument: { assetType: 'ETF' } } });
  });
  it('resolves exact option identity with the opaque returned expiry id', async () => {
    const { p, call } = provider();
    const option: Instrument = {
      ...instrument,
      assetType: 'OPTION',
      underlying: 'TSLA',
      expiry: '2026-11-27',
      strike: '440',
      optionRight: 'CALL',
      multiplier: '100',
      deliverable: 'STANDARD',
    };
    expect((await p.quote(option)).payload).toMatchObject({
      value: { instrument: option },
    });
    expect(call).toHaveBeenCalledWith(
      'get_option_data',
      expect.objectContaining({ expiration_id: 'opaque-expiration-id' }),
    );
    expect(call).toHaveBeenLastCalledWith(
      'get_price_snapshot',
      expect.objectContaining({ contract_id: 456 }),
    );
    await expect(p.quote({ ...option, multiplier: '10' })).rejects.toThrow(
      'standard 100-share',
    );
    await expect(
      provider({
        get_option_parameters: {
          ...parameters,
          expirations: [
            { ...parameters.expirations[0], trading_class: 'TSLA1' },
          ],
        },
      }).p.quote(option),
    ).rejects.toMatchObject({ code: 'INSTRUMENT_MISMATCH' });
    await expect(
      provider({
        get_option_data: {
          ...chain,
          contracts: [{ ...chain.contracts[0], strike: '441' }],
        },
      }).p.quote(option),
    ).rejects.toMatchObject({ code: 'INSTRUMENT_MISMATCH' });
  });
  it('bounds chain snapshots and keeps missing Greeks explicit', async () => {
    const { p, call } = provider();
    const result = await p.options('TSLA', '2026-11-27');
    expect(result.payload).toMatchObject({
      kind: 'options',
      value: [
        { iv: null, delta: null },
        { iv: null, delta: null },
      ],
    });
    expect(call.mock.calls.length).toBeLessThanOrEqual(12);
  });
  it('keeps unknown bar adjustment explicit and discards incomplete bars', async () => {
    const data = {
      chart_step: 3600,
      source: 'Last',
      time: ['2026-10-30T17:00:00Z', '2026-10-31T17:30:00Z'],
      open: ['399', '400'],
      high: ['402', '402'],
      low: ['398', '399'],
      close: ['401', '401'],
      volume: ['1000', '100'],
    };
    const result = await provider({ get_price_history: data }).p.bars('TSLA');
    if (result.payload.kind !== 'bars') throw new Error('Expected bars');
    expect(result.payload.value).toHaveLength(1);
    expect(result.payload.value[0]).toMatchObject({
      adjustment: 'UNKNOWN',
      asOf: '2026-10-30T18:00:00.000Z',
      quality: 'UNKNOWN',
    });
    await expect(
      provider({ get_price_history: { ...data, close: ['401'] } }).p.bars(
        'TSLA',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_MARKET_DATA' });
  });
  it('requires its own authorization and never supplies FX', async () => {
    const { p, call } = provider({}, false);
    await expect(p.quote(instrument)).rejects.toMatchObject({
      code: 'IBKR_AUTH_REQUIRED',
    });
    await expect(p.fx()).rejects.toMatchObject({ code: 'FX_UNAVAILABLE' });
    expect(call).not.toHaveBeenCalled();
  });
});

function oauthFixture(
  options: { grantedScope?: string; resourceIssuer?: string } = {},
) {
  let disk: unknown = null;
  let current = now;
  const store: IbkrSecretStore = {
    read: async () => structuredClone(disk),
    write: async (value) => {
      disk = structuredClone(value);
    },
  };
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const bodyText = String(init?.body ?? '');
    const body: Record<string, unknown> = bodyText.startsWith('{')
      ? (JSON.parse(bodyText) as Record<string, unknown>)
      : Object.fromEntries(new URLSearchParams(bodyText));
    requests.push({ path: url.pathname, body });
    if (url.pathname.includes('oauth-protected-resource'))
      return Response.json({
        resource: IBKR_MCP_URL,
        authorization_servers: [
          options.resourceIssuer ?? 'https://api.ibkr.com',
        ],
        scopes_supported: ['mcp.read', 'mcp.write', 'mcp.orders.submit'],
      });
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return Response.json({
        issuer: 'https://api.ibkr.com',
        authorization_endpoint: 'https://api.ibkr.com/oauth2/authorize',
        token_endpoint: 'https://api.ibkr.com/oauth2/api/v1/token',
        registration_endpoint: 'https://api.ibkr.com/oauth2/register',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    if (url.pathname === '/oauth2/register')
      return Response.json({ ...body, client_id: 'test-client' });
    if (url.pathname === '/oauth2/api/v1/token')
      return Response.json({
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        token_type: 'Bearer',
        scope: options.grantedScope ?? 'mcp.read',
        expires_in: 3600,
      });
    if (url.pathname === '/v1/api/mcp-public') {
      if (init?.method === 'GET') return new Response(null, { status: 405 });
      if (body.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      if (body.method === 'initialize')
        result = {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'ibkr-fixture', version: '1' },
        };
      else if (body.method === 'tools/list')
        result = {
          tools: [
            'search_contracts',
            'get_price_snapshot',
            'get_price_history',
            'get_option_parameters',
            'get_option_data',
            'get_account_positions',
            'create_order_instruction',
          ].map((name) => ({ name, inputSchema: { type: 'object' } })),
        };
      else
        result = {
          content: [
            {
              type: 'text',
              text: '{"last":{"price":400.123456789123,"ts":1793390340},"top-status":{"status":"FROZEN"}}',
            },
          ],
        };
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    }
    throw new Error('Unexpected fixture URL');
  });
  const make = () =>
    new IbkrConnection(
      store,
      'http://127.0.0.1:3000/api/ibkr/callback',
      async () => {},
      transport,
      () => current,
    );
  return {
    connection: make(),
    make,
    requests,
    transport,
    advance: (ms: number) => {
      current += ms;
    },
  };
}
describe('IBKR hosted MCP authorization and allowlist', () => {
  it('persists the private credential store atomically with restricted file permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'm2d-ibkr-test-'));
    const path = join(dir, 'ibkr.json');
    const store = ibkrFileStore(path);
    try {
      expect(await store.read()).toBeNull();
      await store.write({
        version: 1,
        redirectUrl: 'http://127.0.0.1:3000/api/ibkr/callback',
      });
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(
        await store.read(),
      );
      if (process.platform !== 'win32')
        expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await unlink(path);
      await rmdir(dir);
    }
  });
  it('requests only read scope despite broader advertised scopes and preserves PKCE', async () => {
    const { connection, requests } = oauthFixture();
    await connection.load();
    const start = await connection.start();
    const url = new URL(start.authorizationUrl);
    expect(url.searchParams.get('scope')).toBe('mcp.read');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(
      requests.find((r) => r.path === '/oauth2/register')?.body.scope,
    ).toBe('mcp.read');
    expect(await connection.start()).toEqual(start);
    await connection.complete(start.state, 'test-code', 'https://api.ibkr.com');
    expect(
      requests.find((r) => r.path === '/oauth2/api/v1/token')?.body,
    ).toMatchObject({
      grant_type: 'authorization_code',
      code: 'test-code',
      code_verifier: expect.any(String),
    });
    expect(connection.status().connected).toBe(true);
    expect(JSON.stringify(connection.status())).not.toContain(
      'test-access-token',
    );
    await expect(
      connection.complete(start.state, 'test-code', 'https://api.ibkr.com'),
    ).rejects.toMatchObject({ code: 'IBKR_STATE_REJECTED' });
  });
  it('rejects mismatched state/issuer, expired state and excessive granted scope', async () => {
    const f = oauthFixture();
    const start = await f.connection.start();
    await expect(
      f.connection.complete('wrong', 'code', 'https://api.ibkr.com'),
    ).rejects.toMatchObject({ code: 'IBKR_STATE_REJECTED' });
    await expect(
      f.connection.complete(start.state, 'code', 'https://evil.example'),
    ).rejects.toMatchObject({ code: 'IBKR_STATE_REJECTED' });
    f.advance(600001);
    await expect(
      f.connection.complete(start.state, 'code', 'https://api.ibkr.com'),
    ).rejects.toMatchObject({ code: 'IBKR_STATE_REJECTED' });
    expect(f.requests.some((r) => r.path.endsWith('/token'))).toBe(false);
    const broad = oauthFixture({ grantedScope: 'mcp.read mcp.write' });
    const pending = await broad.connection.start();
    await expect(
      broad.connection.complete(pending.state, 'code', 'https://api.ibkr.com'),
    ).rejects.toMatchObject({ code: 'IBKR_SCOPE_REJECTED' });
    expect(broad.connection.connected).toBe(false);
  });
  it('blocks authentication discovery to another origin', async () => {
    const f = oauthFixture({ resourceIssuer: 'https://evil.example' });
    await expect(f.connection.start()).rejects.toMatchObject({
      code: 'IBKR_ENDPOINT_REJECTED',
    });
    expect(f.requests.some((r) => r.path === '/oauth2/register')).toBe(false);
  });
  it('persists authorization, refreshes expired tokens, allows only market tools and preserves decimals', async () => {
    const f = oauthFixture();
    const start = await f.connection.start();
    await f.connection.complete(start.state, 'code', 'https://api.ibkr.com');
    const restarted = f.make();
    await restarted.load();
    expect(restarted.connected).toBe(true);
    f.advance(3600000);
    const session = await restarted.open();
    const result = await session.call('get_price_snapshot', {
      contract_id: 123,
    });
    expect(result.data).toMatchObject({ last: { price: '400.123456789123' } });
    await expect(
      session.call('get_account_positions' as IbkrReadTool, {}),
    ).rejects.toMatchObject({ code: 'IBKR_TOOL_UNAVAILABLE' });
    await expect(
      session.call('create_order_instruction' as IbkrReadTool, {}),
    ).rejects.toMatchObject({ code: 'IBKR_TOOL_UNAVAILABLE' });
    expect(
      f.requests.filter((r) => r.body.method === 'tools/call'),
    ).toHaveLength(1);
    expect(f.requests.some((r) => r.body.grant_type === 'refresh_token')).toBe(
      true,
    );
    await restarted.disconnect();
    expect(restarted.connected).toBe(false);
    await expect(
      session.call('get_price_snapshot', { contract_id: 123 }),
    ).rejects.toMatchObject({ code: 'IBKR_AUTH_REQUIRED' });
    await session.close();
    const again = f.make();
    await again.load();
    expect(again.connected).toBe(false);
  });
});
