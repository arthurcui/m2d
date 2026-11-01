import type { Listing } from './contracts.js';

// Only provider-returned branding assets, never guessed domains or arbitrary URLs.
export function massiveBrandingUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !['api.massive.com', 'api.polygon.io'].includes(url.host) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/v1\/reference\/company-branding\/[A-Za-z0-9_-]+\/images\/[A-Za-z0-9_.-]+$/.test(
        url.pathname,
      )
    )
      return null;
    // Polygon branding paths remain compatible after the provider's rebrand.
    return 'https://api.massive.com' + url.pathname;
  } catch {
    return null;
  }
}

export async function readListingLogo(
  response: Response,
): Promise<NonNullable<Listing['logo']>> {
  if (
    !response.ok ||
    Number(response.headers.get('content-length') ?? 0) > 262144
  ) {
    await response.body?.cancel();
    throw new Error('Logo unavailable');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty logo');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > 262144) {
      await reader.cancel();
      throw new Error('Logo too large');
    }
    chunks.push(next.value);
  }
  const bytes = Buffer.concat(chunks);
  const mime = response.headers.get('content-type')?.split(';')[0]?.trim();
  const hex = bytes.subarray(0, 12).toString('hex');
  if (
    (mime === 'image/png' && hex.startsWith('89504e470d0a1a0a')) ||
    (mime === 'image/jpeg' && hex.startsWith('ffd8ff')) ||
    (mime === 'image/webp' &&
      bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP')
  )
    return { mime, base64: bytes.toString('base64') };
  // SVGs are served as images with sandbox/CSP headers as an additional boundary.
  const svg = bytes.toString('utf8');
  if (
    mime === 'image/svg+xml' &&
    /<svg[\s>]/i.test(svg) &&
    !/<!DOCTYPE|<!ENTITY|<\s*(script|foreignObject|image|use|iframe|style|animate|set)\b|\bon\w+\s*=|\b(?:href|src)\s*=|url\s*\(|@import/i.test(
      svg,
    )
  )
    return { mime, base64: bytes.toString('base64') };
  throw new Error('Unsupported logo');
}
