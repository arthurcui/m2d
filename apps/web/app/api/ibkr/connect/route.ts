import { NextRequest, NextResponse } from 'next/server';
export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  try {
    if (
      !origin ||
      new URL(origin).host !== request.headers.get('host') ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return NextResponse.json(
        { error: { message: 'Connect from M²D in this browser.' } },
        { status: 403 },
      );
    const base = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3001';
    const response = await fetch(base + '/api/v1/market/ibkr/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      cache: 'no-store',
      signal: AbortSignal.timeout(60000),
    });
    const body = (await response.json()) as {
      data?: { authorizationUrl?: string; state?: string };
      error?: { message?: string };
    };
    if (!response.ok || !body.data?.authorizationUrl || !body.data.state)
      return NextResponse.json(
        {
          error: {
            message:
              body.error?.message ?? 'IBKR connection could not be started.',
          },
        },
        { status: response.ok ? 502 : response.status },
      );
    const url = new URL(body.data.authorizationUrl);
    if (
      url.origin !== 'https://api.ibkr.com' ||
      url.pathname !== '/oauth2/authorize' ||
      url.searchParams.get('scope') !== 'mcp.read' ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.data.state)
    )
      throw new Error('Invalid redirect');
    const result = NextResponse.json(
      { authorizationUrl: url.toString() },
      { headers: { 'Cache-Control': 'no-store' } },
    );
    result.cookies.set('m2d-ibkr-state', body.data.state, {
      httpOnly: true,
      sameSite: 'lax',
      secure:
        url.searchParams.get('redirect_uri')?.startsWith('https:') ?? false,
      path: '/api/ibkr',
      maxAge: 600,
    });
    return result;
  } catch {
    return NextResponse.json(
      {
        error: {
          message:
            'IBKR connection could not be started. Check that M²D is running.',
        },
      },
      { status: 502 },
    );
  }
}
