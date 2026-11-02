import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { ResearchError } from './contracts.js';

export function publicUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ResearchError(
      'INVALID_SOURCE_URL',
      'Enter a public HTTPS document or feed URL.',
    );
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
    !url.hostname.includes('.') ||
    url.hostname.endsWith('.localhost')
  )
    throw new ResearchError(
      'INVALID_SOURCE_URL',
      'Only public HTTPS sites on port 443 without credentials are supported.',
    );
  url.hash = '';
  // Signed URLs and API credentials must not become evidence links or saved settings.
  if (
    [...url.searchParams.keys()].some((key) =>
      /^(api[-_]?key|token|access_token|signature|authorization|x-amz-.+)$/i.test(
        key,
      ),
    )
  )
    throw new ResearchError(
      'INVALID_SOURCE_URL',
      'Use a public link without access tokens or signed credentials.',
    );
  return url;
}
export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.parse(address).range() === 'unicast';
  } catch {
    return false;
  }
}
export type PublicResponse = { raw: Uint8Array; mime: string; url: string };
export type PublicGetter = (
  url: string,
  headers?: Record<string, string>,
) => Promise<PublicResponse>;

/** Pin validated DNS results to the TLS connection. Never forward secrets on redirects. */
export const getPublic: PublicGetter = async (input, headers = {}) => {
  let url = publicUrl(input);
  const signal = AbortSignal.timeout(20000);
  for (let redirect = 0; redirect <= 2; redirect++) {
    const addresses = await Promise.race([
      lookup(url.hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) =>
        signal.addEventListener(
          'abort',
          () =>
            reject(
              new ResearchError('SOURCE_TIMEOUT', 'Source lookup timed out.'),
            ),
          { once: true },
        ),
      ),
    ]);
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
      throw new ResearchError(
        'PRIVATE_SOURCE_BLOCKED',
        'The source resolves to a non-public address.',
      );
    const address = addresses[0]!;
    const response = await new Promise<{
      raw: Uint8Array;
      mime: string;
      location?: string;
    }>((resolve, reject) => {
      const req = request(
        url,
        {
          method: 'GET',
          signal,
          agent: false,
          headers: {
            'User-Agent': 'M2D/0.1 public research reader',
            Accept:
              'text/html,application/pdf,application/rss+xml,application/atom+xml,application/json,text/plain',
            'Accept-Encoding': 'identity',
            ...headers,
          },
          lookup: (_host, options, callback) => {
            if (options.all) callback(null, [address]);
            else callback(null, address.address, address.family);
          },
        },
        (res) => {
          if (
            res.statusCode &&
            [301, 302, 303, 307, 308].includes(res.statusCode) &&
            res.headers.location
          ) {
            res.destroy();
            resolve({
              raw: new Uint8Array(),
              mime: '',
              location: res.headers.location,
            });
            return;
          }
          if (res.statusCode !== 200) {
            res.destroy();
            reject(
              new ResearchError(
                'SOURCE_UNAVAILABLE',
                `Source returned HTTP ${res.statusCode ?? 'unknown'}. Saved evidence is unchanged. Open the original site or upload a permitted PDF/text copy.`,
                502,
              ),
            );
            return;
          }
          let size = 0;
          const parts: Buffer[] = [];
          res.on('data', (part: Buffer) => {
            size += part.length;
            if (size > 12 * 1024 * 1024) {
              const error = new ResearchError(
                'DOCUMENT_TOO_LARGE',
                'Source exceeds 12 MiB.',
              );
              reject(error);
              req.destroy(error);
            } else parts.push(part);
          });
          res.once('error', reject);
          res.once('end', () =>
            resolve({
              raw: Buffer.concat(parts),
              mime: String(res.headers['content-type'] ?? '')
                .split(';')[0]!
                .toLowerCase(),
            }),
          );
        },
      );
      req.once('error', (e) =>
        reject(
          e instanceof ResearchError
            ? e
            : new ResearchError(
                'SOURCE_UNAVAILABLE',
                'Could not retrieve this public source. It may require a browser or be temporarily unavailable.',
                502,
              ),
        ),
      );
      req.end();
    });
    if (!response.location)
      return { raw: response.raw, mime: response.mime, url: url.href };
    if (Object.keys(headers).length)
      throw new ResearchError(
        'SOURCE_REDIRECT',
        'Authenticated source redirects are not followed.',
      );
    url = publicUrl(new URL(response.location, url).href);
  }
  throw new ResearchError(
    'SOURCE_REDIRECT',
    'Too many source redirects. Use the final public URL.',
  );
};
