import { it, expect, vi } from 'vitest';
import {
  MassiveBasicProvider,
  FixtureMarketProvider,
  listingLookup,
  listingKey,
  payloadSchema,
} from '../packages/market/src/index.js';
import {
  massiveBrandingUrl,
  readListingLogo,
} from '../packages/market/src/listing-logo.js';
const lookup = {
  symbol: 'GOOGL',
  exchange: 'UNKNOWN',
  currency: 'USD',
  assetType: 'STOCK' as const,
};
const icon =
  'https://api.massive.com/v1/reference/company-branding/Z29vZ2xlLmNvbQ/images/2026-10-30_icon.png';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=',
  'base64',
);
function provider(
  name = 'Alphabet Inc. Class A Common Stock',
  branding: unknown = { icon_url: icon },
  image = new Response(png, { headers: { 'Content-Type': 'image/png' } }),
) {
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        status: 'OK',
        results: {
          ticker: 'GOOGL',
          name,
          market: 'stocks',
          locale: 'us',
          primary_exchange: 'XNAS',
          currency_name: 'usd',
          type: 'CS',
          branding,
        },
      }),
    )
    .mockResolvedValueOnce(image);
  let now = Date.parse('2026-10-31T18:00:00Z');
  const gate = vi.fn(async () => {});
  return {
    transport,
    gate,
    p: new MassiveBasicProvider(
      'test-secret',
      gate,
      transport,
      () => now,
      async (ms) => {
        now += ms;
      },
    ),
  };
}
it('uses the listing name and retrieves a verified logo through the paced backend only', async () => {
  const { p, transport, gate } = provider();
  const result = await p.fetchListing(lookup);
  expect(payloadSchema.parse(result.payload)).toMatchObject({
    kind: 'listing',
    value: {
      name: 'Alphabet Inc. Class A Common Stock',
      exchange: 'XNAS',
      logo: { mime: 'image/png', base64: png.toString('base64') },
      logoIssue: null,
    },
  });
  expect(gate).toHaveBeenCalledTimes(2);
  expect(String(transport.mock.calls[0]![0])).toContain(
    '/v3/reference/tickers/GOOGL?date=2026-10-31',
  );
  expect(transport.mock.calls[1]).toMatchObject([
    icon,
    { headers: { Authorization: 'Bearer test-secret' }, redirect: 'error' },
  ]);
  expect(JSON.stringify(result)).not.toContain('test-secret');
});
it('keeps the full name when a logo is absent or unavailable', async () => {
  const absent = await provider('Alphabet Inc.', {}).p.fetchListing(lookup);
  expect(absent.payload).toMatchObject({
    value: { name: 'Alphabet Inc.', logo: null, logoIssue: 'NOT_PROVIDED' },
  });
  const broken = await provider(
    'Alphabet Inc.',
    { icon_url: icon },
    new Response('', { status: 403 }),
  ).p.fetchListing(lookup);
  expect(broken.payload).toMatchObject({
    value: { name: 'Alphabet Inc.', logo: null, logoIssue: 'UNAVAILABLE' },
  });
});
it('rejects mismatched listing class, exchange, symbol and currency before loading a logo', async () => {
  for (const change of [
    { assetType: 'ETF' as const },
    { symbol: 'GOOG' },
    { exchange: 'NYSE' },
    { currency: 'CAD' },
  ]) {
    const { p, transport } = provider();
    await expect(p.fetchListing({ ...lookup, ...change })).rejects.toThrow();
    expect(transport.mock.calls.length).toBeLessThanOrEqual(1);
  }
});
it('does not invent a name or fetch a guessed/untrusted logo URL', async () => {
  const { p, transport } = provider('Alphabet Inc.', {
    icon_url: 'http://127.0.0.1/private',
  });
  expect((await p.fetchListing(lookup)).payload).toMatchObject({
    value: { logo: null },
  });
  expect(transport).toHaveBeenCalledTimes(1);
  await expect(provider('').p.fetchListing(lookup)).rejects.toThrow();
});
it('pins branding hosts and paths and excludes credentials, redirects and query strings', () => {
  expect(massiveBrandingUrl(icon)).toBe(icon);
  expect(
    massiveBrandingUrl(icon.replace('api.massive.com', 'api.polygon.io')),
  ).toBe(icon);
  for (const bad of [
    icon + '?apiKey=secret',
    icon + '#x',
    icon.replace('https:', 'http:'),
    icon.replace('api.massive.com', 'api.massive.com.attacker.test'),
    icon.replace('api.massive.com', 'user:pass@api.massive.com'),
    'https://api.massive.com/other/path',
    'http://localhost/image',
  ])
    expect(massiveBrandingUrl(bad)).toBeNull();
});
it('rejects active SVG, fake image types and oversized streams', async () => {
  for (const svg of [
    '<svg><script>alert(1)</script></svg>',
    '<svg onload="x"/>',
    '<svg><image href="https://other.test/x"/></svg>',
    '<!DOCTYPE svg><svg/>',
  ])
    await expect(
      readListingLogo(
        new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } }),
      ),
    ).rejects.toThrow();
  await expect(
    readListingLogo(
      new Response('<html>oops</html>', {
        headers: { 'Content-Type': 'image/png' },
      }),
    ),
  ).rejects.toThrow();
  await expect(
    readListingLogo(
      new Response(new Uint8Array(262145), {
        headers: { 'Content-Type': 'image/png' },
      }),
    ),
  ).rejects.toThrow();
});
it('deduplicates option legs to their underlying listing and keeps equity classes distinct', () => {
  const base = {
    assetType: 'OPTION' as const,
    symbol: 'GOOGL',
    exchange: 'OPRA',
    currency: 'USD',
    underlying: 'GOOGL',
    multiplier: '100',
    deliverable: 'STANDARD' as const,
    optionRight: 'CALL' as const,
    expiry: '2026-12-18',
    strike: '200',
  };
  expect(listingKey(listingLookup(base))).toBe(
    listingKey(listingLookup({ ...base, strike: '300', optionRight: 'PUT' })),
  );
  expect(listingLookup(base)).toEqual({ ...lookup, assetType: 'EQUITY' });
  expect(listingKey({ ...lookup, assetType: 'ETF' })).not.toBe(
    listingKey(lookup),
  );
});
it('provides synthetic names and a demo logo entirely offline', async () => {
  const result = await new FixtureMarketProvider().fetchListing({
    ...lookup,
    symbol: 'TSLL',
    assetType: 'ETF',
  });
  expect(payloadSchema.parse(result.payload)).toMatchObject({
    kind: 'listing',
    value: {
      name: 'Direxion Daily TSLA Bull 2X Shares',
      quality: 'FIXTURE',
      assetType: 'ETF',
      logo: { mime: 'image/svg+xml' },
    },
  });
});
