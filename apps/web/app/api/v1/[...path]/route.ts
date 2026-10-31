// Explicit read-only M0 proxy. Runtime URL; no database or provider secrets in web.
const allowed = new Set([
  'health',
  'health/live',
  'health/ready',
  'system/status',
]);
export async function GET(
  _request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const path = (await context.params).path.join('/');
  if (!allowed.has(path))
    return Response.json(
      { error: { code: 'NOT_FOUND', message: 'Route unavailable in M0.' } },
      { status: 404 },
    );
  try {
    const base = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3001';
    const response = await fetch(`${base}/api/v1/${path}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    return new Response(await response.text(), {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return Response.json(
      {
        error: {
          code: 'API_UNAVAILABLE',
          message: 'Local API is unavailable.',
        },
      },
      { status: 503 },
    );
  }
}
