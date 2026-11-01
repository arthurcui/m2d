// Explicit M2 proxy: bounded paths/bodies and same-origin browser writes.
const reads =
  /^(health(?:\/(?:live|ready))?|system\/status|accounts|portfolio\/(?:overview|positions|cash|history|template)|portfolio\/(?:changes|imports)\/[0-9a-f-]{36}\/(?:preview|inspection)|portfolio\/accounts\/[A-Za-z0-9_.-]{1,64}\/history)$/;
const writes =
  /^(portfolio\/changes\/preview|portfolio\/imports|portfolio\/changes\/[0-9a-f-]{36}\/(?:confirm|reject)|portfolio\/imports\/[0-9a-f-]{36}\/(?:confirm|mapping|parse)|portfolio\/baselines\/[0-9a-f-]{36}\/restore-preview)$/;
async function proxy(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const path = (await context.params).path.join('/');
  const post = request.method !== 'GET';
  const researchRead =
    /^research(?:\/(?:sources|imports\/[0-9a-f-]{36}|companies(?:\/[A-Z0-9.-]{1,24})?|documents\/[0-9a-f-]{36}(?:\/raw)?|search(?:\/(?:status|jobs\/[0-9a-f-]{36}))?))?$/;
  const researchWrite =
    /^research\/(?:import|upload|compare|sources(?:\/(?:remove|discover|import))?|search(?:\/index)?)$/;
  const marketRead =
    /^(portfolio\/(?:valuation|listings)|market\/(?:settings|status|quotes|fx|snapshots|listings\/[0-9a-f-]{36}\/logo|ibkr\/status|(?:bars|options)\/[A-Z0-9.^-]{1,24}))$/;
  const marketWrite =
    /^market\/(?:settings|refresh|snapshots|ibkr\/disconnect)$/;
  const chatRead =
    /^(settings\/analysis|chat\/sessions\/[a-z]+|chat\/runs\/[0-9a-f-]{36}(?:\/events)?)$/;
  const chatWrite =
    /^(settings\/analysis|chat\/sessions\/[a-z]+(?:\/(?:runs|reset))?|chat\/runs\/[0-9a-f-]{36}\/cancel)$/;
  if (
    !(post ? writes : reads).test(path) &&
    !(post ? chatWrite : chatRead).test(path) &&
    !(post ? marketWrite : marketRead).test(path) &&
    !(post ? researchWrite : researchRead).test(path)
  )
    return Response.json(
      { error: { code: 'NOT_FOUND', message: 'Route unavailable.' } },
      { status: 404 },
    );
  if (post) {
    const origin = request.headers.get('origin');
    const host = request.headers.get('host');
    if (
      !origin ||
      new URL(origin).host !== host ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return Response.json(
        {
          error: {
            code: 'ORIGIN_REJECTED',
            message: 'Submit changes from M²D in this browser.',
          },
        },
        { status: 403 },
      );
  }
  try {
    let body: Uint8Array | undefined;
    if (post) {
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (
            size >
            (path === 'research/upload'
              ? 17 * 1024 * 1024
              : 2 * 1024 * 1024 + 16384)
          ) {
            await reader.cancel();
            return Response.json(
              {
                error: {
                  code: 'UPLOAD_TOO_LARGE',
                  message:
                    path === 'research/upload'
                      ? 'Document limit is 12 MiB.'
                      : 'Workbook limit is 2 MiB.',
                },
              },
              { status: 413 },
            );
          }
          chunks.push(next.value);
        }
      body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
    }
    const base = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3001';
    const query = new URL(request.url).search;
    const response = await fetch(`${base}/api/v1/${path}${query}`, {
      method: request.method,
      cache: 'no-store',
      ...(request.headers.get('last-event-id')
        ? {
            headers: { 'Last-Event-ID': request.headers.get('last-event-id')! },
          }
        : {}),
      signal: AbortSignal.any([
        request.signal,
        AbortSignal.timeout(
          path.endsWith('/events')
            ? 320000
            : path.endsWith('/parse')
              ? 135000
              : path === 'market/refresh'
                ? 120000
                : 15000,
        ),
      ]),
      ...(post
        ? {
            body: body as BodyInit,
            headers: {
              'Content-Type':
                request.headers.get('content-type') ?? 'application/json',
            },
          }
        : {}),
    });
    return new Response(response.body, {
      status: response.status,
      headers: {
        'Content-Type':
          response.headers.get('content-type') ?? 'application/json',
        'Cache-Control':
          path.endsWith('/logo') && response.ok
            ? 'private, max-age=86400, immutable'
            : 'no-store',
        ...(path.endsWith('/logo') || path.endsWith('/raw')
          ? {
              'X-Content-Type-Options': 'nosniff',
              'Content-Security-Policy': "default-src 'none'; sandbox",
            }
          : {}),
        ...(response.headers.get('content-disposition')
          ? {
              'Content-Disposition': response.headers.get(
                'content-disposition',
              )!,
            }
          : {}),
      },
    });
  } catch {
    return Response.json(
      {
        error: {
          code: 'API_UNAVAILABLE',
          message:
            'M²D is temporarily unavailable. Retry the same preview confirmation safely; do not enter the change again.',
        },
      },
      { status: 503 },
    );
  }
}
export const GET = proxy;
export const POST = proxy;

export const PATCH = proxy;
