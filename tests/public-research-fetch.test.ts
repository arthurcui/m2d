import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));
import { getPublic } from '../packages/research/dist/public-fetch.js';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
});
function respond(
  status: number,
  headers: Record<string, string>,
  body = 'Public document',
) {
  mocks.request.mockImplementationOnce(
    (_url: URL, _options: unknown, callback: (r: EventEmitter) => void) => {
      const res = Object.assign(new EventEmitter(), {
        statusCode: status,
        headers,
        destroy: vi.fn(),
      });
      const req = Object.assign(new EventEmitter(), {
        end() {
          queueMicrotask(() => {
            callback(res);
            res.emit('data', Buffer.from(body));
            res.emit('end');
          });
        },
        destroy(error: Error) {
          queueMicrotask(() => req.emit('error', error));
        },
      });
      return req;
    },
  );
}
it('rejects mixed public/private DNS results before opening a socket', async () => {
  mocks.lookup.mockResolvedValue([
    { address: '8.8.8.8', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]);
  await expect(
    getPublic('https://issuer.example/report'),
  ).rejects.toMatchObject({ code: 'PRIVATE_SOURCE_BLOCKED' });
  expect(mocks.request).not.toHaveBeenCalled();
});
it('pins TLS lookup to the validated address and caps response size', async () => {
  respond(200, { 'content-type': 'text/plain' });
  expect((await getPublic('https://issuer.example/report')).mime).toBe(
    'text/plain',
  );
  const options = mocks.request.mock.calls[0]![1] as {
    lookup: (
      host: string,
      options: { all: boolean },
      callback: (error: Error | null, address: unknown) => void,
    ) => void;
  };
  const callback = vi.fn();
  options.lookup('issuer.example', { all: true }, callback);
  expect(callback).toHaveBeenCalledWith(null, [
    { address: '8.8.8.8', family: 4 },
  ]);
  respond(
    200,
    { 'content-type': 'text/plain' },
    'x'.repeat(12 * 1024 * 1024 + 1),
  );
  await expect(getPublic('https://issuer.example/large')).rejects.toMatchObject(
    { code: 'DOCUMENT_TOO_LARGE' },
  );
});
it('rejects private redirects and never forwards authenticated requests', async () => {
  respond(302, { location: 'https://127.0.0.1/private' });
  await expect(
    getPublic('https://issuer.example/report'),
  ).rejects.toMatchObject({ code: 'INVALID_SOURCE_URL' });
  respond(302, { location: 'https://other.example/collect' });
  await expect(
    getPublic('https://api.massive.com/news', {
      Authorization: 'Bearer private',
    }),
  ).rejects.toMatchObject({ code: 'SOURCE_REDIRECT' });
  expect(mocks.request).toHaveBeenCalledTimes(2);
});
